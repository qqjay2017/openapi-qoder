import ts from 'typescript';

export type TypeShape =
  | { kind: 'primitive'; name: string }
  | { kind: 'literal'; value: string }
  | { kind: 'array'; item: TypeShape }
  | { kind: 'tuple'; items: TypeShape[] }
  | { kind: 'object'; fields: FieldShape[] }
  | { kind: 'union'; types: TypeShape[] }
  | { kind: 'intersection'; types: TypeShape[] }
  | { kind: 'generic'; name: string; args: TypeShape[] };

export interface FieldShape {
  key: string;
  optional: boolean;
  readonly: boolean;
  type: TypeShape;
}

export interface EndpointSummary {
  name: string;
  method: string;
  url: string;
  request: TypeShape;
  response: TypeShape;
  runtime: string;
}

export interface ExportedTypeSummary {
  name: string;
  shape: TypeShape;
}

export interface SourceSummary {
  endpoints: EndpointSummary[];
  exportedTypes: ExportedTypeSummary[];
  errors: string[];
}

type TypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration;
type Substitutions = Map<string, TypeShape>;

const UNKNOWN: TypeShape = { kind: 'primitive', name: 'unknown' };
const ANY: TypeShape = { kind: 'primitive', name: 'any' };
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

function stable(shape: TypeShape): string {
  return JSON.stringify(shape);
}

function exported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function readonly(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
  );
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function literalShape(node: ts.Expression): TypeShape | undefined {
  if (ts.isStringLiteralLike(node)) return { kind: 'literal', value: `string:${node.text}` };
  if (ts.isNumericLiteral(node)) return { kind: 'literal', value: `number:${node.text}` };
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: 'literal', value: `boolean:${node.kind === ts.SyntaxKind.TrueKeyword}` };
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: 'null' };
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return { kind: 'literal', value: `number:-${node.operand.text}` };
  }
  return undefined;
}

function normalizeUnion(types: TypeShape[]): TypeShape {
  const flat = types.flatMap((type) => (type.kind === 'union' ? type.types : [type]));
  const unique = new Map(flat.map((type) => [stable(type), type]));
  const sorted = [...unique.values()].sort((a, b) => stable(a).localeCompare(stable(b)));
  return sorted.length === 1 ? sorted[0]! : { kind: 'union', types: sorted };
}

function normalizeIntersection(types: TypeShape[]): TypeShape {
  const flat = types.flatMap((type) => (type.kind === 'intersection' ? type.types : [type]));
  if (flat.every((type) => type.kind === 'object')) {
    const fields = new Map<string, FieldShape>();
    for (const object of flat) {
      for (const field of object.fields) {
        const previous = fields.get(field.key);
        if (!previous) fields.set(field.key, field);
        else if (JSON.stringify(previous) !== JSON.stringify(field)) {
          return {
            kind: 'intersection',
            types: flat.sort((a, b) => stable(a).localeCompare(stable(b))),
          };
        }
      }
    }
    return objectShape([...fields.values()]);
  }
  const unique = new Map(flat.map((type) => [stable(type), type]));
  const sorted = [...unique.values()].sort((a, b) => stable(a).localeCompare(stable(b)));
  return sorted.length === 1 ? sorted[0]! : { kind: 'intersection', types: sorted };
}

function objectShape(fields: FieldShape[]): TypeShape {
  return { kind: 'object', fields: [...fields].sort((a, b) => a.key.localeCompare(b.key)) };
}

function literalKeys(shape: TypeShape): Set<string> | undefined {
  if (shape.kind === 'primitive' && shape.name === 'never') return new Set();
  const types = shape.kind === 'union' ? shape.types : [shape];
  const keys = new Set<string>();
  for (const type of types) {
    if (type.kind !== 'literal' || !type.value.startsWith('string:')) return undefined;
    keys.add(type.value.slice('string:'.length));
  }
  return keys;
}

class TypeResolver {
  private readonly declarations = new Map<string, TypeDeclaration[]>();
  private readonly constObjects = new Map<string, TypeShape>();
  private readonly imports = new Map<string, string>();
  private readonly resolving = new Set<string>();

  constructor(private readonly sourceFile: ts.SourceFile) {
    for (const statement of sourceFile.statements) {
      if (
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name
      ) {
        const list = this.declarations.get(statement.name.text) ?? [];
        list.push(statement);
        this.declarations.set(statement.name.text, list);
      }
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        if (clause?.name) this.imports.set(clause.name.text, 'default');
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            this.imports.set(element.name.text, element.propertyName?.text ?? element.name.text);
          }
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          const value = this.resolveConstExpression(declaration.initializer);
          if (value) this.constObjects.set(declaration.name.text, value);
        }
      }
    }
  }

  resolve(node: ts.TypeNode | undefined, substitutions: Substitutions = new Map()): TypeShape {
    if (!node) return ANY;
    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { kind: 'primitive', name: 'string' };
      case ts.SyntaxKind.NumberKeyword:
        return { kind: 'primitive', name: 'number' };
      case ts.SyntaxKind.BooleanKeyword:
        return { kind: 'primitive', name: 'boolean' };
      case ts.SyntaxKind.UnknownKeyword:
        return UNKNOWN;
      case ts.SyntaxKind.AnyKeyword:
        return ANY;
      case ts.SyntaxKind.NeverKeyword:
        return { kind: 'primitive', name: 'never' };
      case ts.SyntaxKind.VoidKeyword:
        return { kind: 'primitive', name: 'void' };
      case ts.SyntaxKind.UndefinedKeyword:
        return { kind: 'primitive', name: 'undefined' };
      case ts.SyntaxKind.ObjectKeyword:
        return { kind: 'primitive', name: 'object' };
      case ts.SyntaxKind.BigIntKeyword:
        return { kind: 'primitive', name: 'bigint' };
      case ts.SyntaxKind.SymbolKeyword:
        return { kind: 'primitive', name: 'symbol' };
    }
    if (ts.isParenthesizedTypeNode(node)) return this.resolve(node.type, substitutions);
    if (ts.isArrayTypeNode(node)) return { kind: 'array', item: this.resolve(node.elementType, substitutions) };
    if (ts.isTupleTypeNode(node)) {
      return {
        kind: 'tuple',
        items: node.elements.map((item) =>
          this.resolve(ts.isNamedTupleMember(item) ? item.type : item, substitutions),
        ),
      };
    }
    if (ts.isLiteralTypeNode(node)) {
      return literalShape(node.literal) ?? { kind: 'primitive', name: node.getText(this.sourceFile) };
    }
    if (ts.isUnionTypeNode(node)) {
      return normalizeUnion(node.types.map((type) => this.resolve(type, substitutions)));
    }
    if (ts.isIntersectionTypeNode(node)) {
      return normalizeIntersection(node.types.map((type) => this.resolve(type, substitutions)));
    }
    if (ts.isTypeLiteralNode(node)) return this.members(node.members, substitutions);
    if (ts.isTypeReferenceNode(node)) return this.reference(node, substitutions);
    if (ts.isTypeQueryNode(node)) {
      const name = ts.isIdentifier(node.exprName) ? node.exprName.text : node.exprName.getText(this.sourceFile);
      return this.constObjects.get(name) ?? { kind: 'generic', name: `typeof:${name}`, args: [] };
    }
    if (ts.isIndexedAccessTypeNode(node)) return this.indexedAccess(node, substitutions);
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.KeyOfKeyword) {
      const target = this.resolve(node.type, substitutions);
      if (target.kind === 'object') {
        return normalizeUnion(
          target.fields.map((field) => ({ kind: 'literal', value: `string:${field.key}` })),
        );
      }
    }
    if (ts.isFunctionTypeNode(node)) {
      return {
        kind: 'generic',
        name: 'function',
        args: [
          ...node.parameters.map((parameter) => this.resolve(parameter.type, substitutions)),
          this.resolve(node.type, substitutions),
        ],
      };
    }
    return { kind: 'generic', name: `syntax:${node.kind}`, args: [] };
  }

  private reference(node: ts.TypeReferenceNode, substitutions: Substitutions): TypeShape {
    const localName = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.getText(this.sourceFile);
    const replacement = substitutions.get(localName);
    if (replacement && !node.typeArguments?.length) return replacement;
    const args = node.typeArguments?.map((argument) => this.resolve(argument, substitutions)) ?? [];
    if ((localName === 'Array' || localName === 'ReadonlyArray') && args.length === 1) {
      return { kind: 'array', item: args[0]! };
    }
    if ((localName === 'Pick' || localName === 'Omit') && args.length === 2) {
      const target = args[0]!;
      const keys = literalKeys(args[1]!);
      if (target.kind === 'object' && keys) {
        return objectShape(
          target.fields.filter((field) =>
            localName === 'Pick' ? keys.has(field.key) : !keys.has(field.key),
          ),
        );
      }
    }
    const declarations = this.declarations.get(localName);
    if (declarations?.length) {
      const key = `${localName}<${args.map(stable).join(',')}>`;
      if (this.resolving.has(key)) return { kind: 'generic', name: localName, args };
      this.resolving.add(key);
      const shapes = declarations.map((declaration) => {
        const typeParameters = ts.isEnumDeclaration(declaration)
          ? []
          : (declaration.typeParameters ?? []);
        const next = new Map(substitutions);
        typeParameters.forEach((parameter: ts.TypeParameterDeclaration, index: number) => {
          const value =
            args[index] ??
            (parameter.default
              ? this.resolve(parameter.default, substitutions)
              : { kind: 'generic' as const, name: `type-parameter:${index}`, args: [] });
          next.set(parameter.name.text, value);
        });
        if (ts.isTypeAliasDeclaration(declaration)) return this.resolve(declaration.type, next);
        if (ts.isEnumDeclaration(declaration)) return this.enumShape(declaration);
        const own = this.members(declaration.members, next);
        const bases =
          declaration.heritageClauses?.flatMap((clause) =>
            clause.types.map((type) => this.heritage(type, next)),
          ) ?? [];
        return normalizeIntersection([...bases, own]);
      });
      this.resolving.delete(key);
      return normalizeIntersection(shapes);
    }
    return { kind: 'generic', name: this.imports.get(localName) ?? localName, args };
  }

  private heritage(node: ts.ExpressionWithTypeArguments, substitutions: Substitutions): TypeShape {
    const name = node.expression.getText(this.sourceFile);
    const synthetic = ts.factory.createTypeReferenceNode(
      name,
      node.typeArguments ? [...node.typeArguments] : undefined,
    );
    return this.reference(synthetic, substitutions);
  }

  private members(members: ts.NodeArray<ts.TypeElement>, substitutions: Substitutions): TypeShape {
    const fields: FieldShape[] = [];
    for (const member of members) {
      if (ts.isPropertySignature(member)) {
        const key = propertyName(member.name);
        if (key !== undefined) {
          fields.push({
            key,
            optional: !!member.questionToken,
            readonly: readonly(member),
            type: this.resolve(member.type, substitutions),
          });
        }
      } else if (ts.isMethodSignature(member)) {
        const key = propertyName(member.name);
        if (key !== undefined) {
          fields.push({
            key,
            optional: !!member.questionToken,
            readonly: false,
            type: {
              kind: 'generic',
              name: 'function',
              args: [
                ...member.parameters.map((parameter) => this.resolve(parameter.type, substitutions)),
                this.resolve(member.type, substitutions),
              ],
            },
          });
        }
      }
    }
    return objectShape(fields);
  }

  private enumShape(node: ts.EnumDeclaration): TypeShape {
    const values: TypeShape[] = [];
    let nextNumber = 0;
    for (const member of node.members) {
      const literal = member.initializer && literalShape(member.initializer);
      if (literal) {
        values.push(literal);
        if (literal.kind === 'literal' && literal.value.startsWith('number:')) {
          nextNumber = Number(literal.value.slice(7)) + 1;
        }
      } else {
        values.push({ kind: 'literal', value: `number:${nextNumber++}` });
      }
    }
    return normalizeUnion(values);
  }

  private indexedAccess(node: ts.IndexedAccessTypeNode, substitutions: Substitutions): TypeShape {
    const object = this.resolve(node.objectType, substitutions);
    const index = this.resolve(node.indexType, substitutions);
    if (object.kind === 'object') {
      const keys = literalKeys(index);
      if (keys) {
        return normalizeUnion(
          object.fields.filter((field) => keys.has(field.key)).map((field) => field.type),
        );
      }
    }
    return { kind: 'generic', name: 'indexed-access', args: [object, index] };
  }

  private resolveConstExpression(expression: ts.Expression): TypeShape | undefined {
    let node = expression;
    while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
      node = node.expression;
    }
    const literal = literalShape(node);
    if (literal) return literal;
    if (ts.isObjectLiteralExpression(node)) {
      const fields: FieldShape[] = [];
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
        const key = propertyName(property.name);
        const value = ts.isShorthandPropertyAssignment(property)
          ? this.constObjects.get(property.name.text)
          : this.resolveConstExpression(property.initializer);
        if (key === undefined || !value) return undefined;
        fields.push({ key, optional: false, readonly: false, type: value });
      }
      return objectShape(fields);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const items = node.elements.map((item) =>
        ts.isSpreadElement(item) ? undefined : this.resolveConstExpression(item),
      );
      if (items.some((item) => !item)) return undefined;
      return { kind: 'tuple', items: items as TypeShape[] };
    }
    return undefined;
  }

  exportedTypes(): ExportedTypeSummary[] {
    const result: ExportedTypeSummary[] = [];
    for (const statement of this.sourceFile.statements) {
      if (
        exported(statement) &&
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement))
      ) {
        const reference = ts.factory.createTypeReferenceNode(statement.name.text, undefined);
        result.push({ name: statement.name.text, shape: this.resolve(reference) });
      }
    }
    return result;
  }

  exportedValues(): { name: string; shape: TypeShape }[] {
    const result: { name: string; shape: TypeShape }[] = [];
    for (const statement of this.sourceFile.statements) {
      if (!exported(statement)) continue;
      if (ts.isEnumDeclaration(statement)) {
        const fields = statement.members.map((member, index): FieldShape => ({
          key: propertyName(member.name) ?? String(index),
          optional: false,
          readonly: true,
          type: (member.initializer && literalShape(member.initializer)) ?? {
            kind: 'literal',
            value: `number:${index}`,
          },
        }));
        result.push({ name: statement.name.text, shape: objectShape(fields) });
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            !ts.isArrowFunction(declaration.initializer) &&
            !ts.isFunctionExpression(declaration.initializer)
          ) {
            const shape = this.resolveConstExpression(declaration.initializer);
            if (shape) result.push({ name: declaration.name.text, shape });
          }
        }
      }
    }
    return result;
  }
}

interface FunctionOwner {
  name: string;
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;
}

function requestClientNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>(['request']);
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.toLowerCase().includes('request') &&
      statement.importClause?.name
    ) {
      names.add(statement.importClause.name.text);
    }
  }
  return names;
}

function requestCall(node: ts.Node, clients: Set<string>): ts.CallExpression | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const receiver = node.expression.expression;
  const method = node.expression.name.text.toLowerCase();
  return ts.isIdentifier(receiver) && clients.has(receiver.text) && HTTP_METHODS.has(method)
    ? node
    : undefined;
}

function findCalls(node: ts.Node, clients: Set<string>): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    const call = requestCall(child, clients);
    if (call) calls.push(call);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls;
}

function exportedFunctions(sourceFile: ts.SourceFile): FunctionOwner[] {
  const functions: FunctionOwner[] = [];
  for (const statement of sourceFile.statements) {
    if (!exported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      functions.push({ name: statement.name.text, node: statement });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
        ) {
          functions.push({ name: declaration.name.text, node: declaration.initializer });
        }
      }
    }
  }
  return functions;
}

function staticRuntimeKey(name: ts.PropertyName): string {
  return propertyName(name) ?? `computed:${name.getText()}`;
}

function runtimeFingerprint(owner: FunctionOwner): string {
  const bindings = new Map<string, string>();
  owner.node.parameters.forEach((parameter, index) => {
    if (ts.isIdentifier(parameter.name)) bindings.set(parameter.name.text, `$p${index}`);
  });

  const print = (node: ts.Node): string => {
    if (ts.isIdentifier(node)) return bindings.get(node.text) ?? `id:${node.text}`;
    if (ts.isStringLiteralLike(node)) return `str:${JSON.stringify(node.text)}`;
    if (ts.isNumericLiteral(node)) return `num:${node.text}`;
    if (ts.isPropertyAccessExpression(node)) return `prop(${print(node.expression)},${node.name.text})`;
    if (ts.isElementAccessExpression(node)) return `element(${print(node.expression)},${print(node.argumentExpression)})`;
    if (ts.isCallExpression(node)) return `call(${print(node.expression)};${node.arguments.map(print).join(',')})`;
    if (ts.isObjectLiteralExpression(node)) {
      return `object(${node.properties
        .map((property) => {
          if (ts.isShorthandPropertyAssignment(property)) {
            return `${property.name.text}:${print(property.name)}`;
          }
          if (ts.isPropertyAssignment(property)) {
            return `${staticRuntimeKey(property.name)}:${print(property.initializer)}`;
          }
          if (ts.isSpreadAssignment(property)) return `...${print(property.expression)}`;
          return print(property);
        })
        .join(',')})`;
    }
    if (ts.isArrayLiteralExpression(node)) return `array(${node.elements.map(print).join(',')})`;
    if (ts.isParenthesizedExpression(node)) return print(node.expression);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
      return print(node.expression);
    }
    if (ts.isBlock(node)) return `block(${node.statements.map(print).join(';')})`;
    if (ts.isReturnStatement(node)) return `return(${node.expression ? print(node.expression) : ''})`;
    if (ts.isExpressionStatement(node)) return `expr(${print(node.expression)})`;
    if (ts.isAwaitExpression(node)) return `await(${print(node.expression)})`;
    if (ts.isSpreadElement(node)) return `...${print(node.expression)}`;
    if (ts.isConditionalExpression(node)) {
      return `conditional(${print(node.condition)},${print(node.whenTrue)},${print(node.whenFalse)})`;
    }
    if (ts.isBinaryExpression(node)) {
      return `binary(${node.operatorToken.kind},${print(node.left)},${print(node.right)})`;
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      return `unary(${node.operator},${print(node.operand)})`;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
      return ts.SyntaxKind[node.kind];
    }
    const children: string[] = [];
    ts.forEachChild(node, (child) => {
      if (!ts.isTypeNode(child)) children.push(print(child));
    });
    return `${ts.SyntaxKind[node.kind]}(${children.join(',')})`;
  };

  return `params:${owner.node.parameters.length};${print(owner.node.body!)}`;
}

function parseErrors(sourceFile: ts.SourceFile): string[] {
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  return (diagnostics ?? []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  );
}

function policyErrors(sourceFile: ts.SourceFile): string[] {
  const errors: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) errors.push(`forbidden any at ${position(sourceFile, node)}`);
    if (ts.isNonNullExpression(node)) errors.push(`forbidden non-null assertion at ${position(sourceFile, node)}`);
    if (ts.isTypeAssertionExpression(node)) errors.push(`forbidden type assertion at ${position(sourceFile, node)}`);
    if (ts.isAsExpression(node) && node.type.getText(sourceFile) !== 'const') {
      errors.push(`forbidden as assertion at ${position(sourceFile, node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return errors;
}

function position(sourceFile: ts.SourceFile, node: ts.Node): string {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${point.line + 1}:${point.character + 1}`;
}

interface InternalSummary extends SourceSummary {
  exportedValues: { name: string; shape: TypeShape }[];
  runtimeImports: string[];
}

function summarize(source: string): InternalSummary {
  const sourceFile = ts.createSourceFile('polished.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const resolver = new TypeResolver(sourceFile);
  const errors = [...parseErrors(sourceFile), ...policyErrors(sourceFile)];
  const clients = requestClientNames(sourceFile);
  const endpoints: EndpointSummary[] = [];
  const ownedCalls = new Set<ts.CallExpression>();

  for (const owner of exportedFunctions(sourceFile)) {
    const calls = findCalls(owner.node.body!, clients);
    for (const call of calls) {
      ownedCalls.add(call);
      const access = call.expression as ts.PropertyAccessExpression;
      const urlNode = call.arguments[0];
      if (!urlNode || (!ts.isStringLiteralLike(urlNode) && !ts.isNoSubstitutionTemplateLiteral(urlNode))) {
        errors.push(`request call in ${owner.name} must use a literal URL`);
        continue;
      }
      const requestType = call.typeArguments?.[1] ?? owner.node.parameters[0]?.type;
      const responseType = call.typeArguments?.[0];
      if (!requestType || !responseType) {
        errors.push(`request call in ${owner.name} must expose request and response types`);
      }
      endpoints.push({
        name: owner.name,
        method: access.name.text.toUpperCase(),
        url: urlNode.text,
        request: resolver.resolve(requestType),
        response: resolver.resolve(responseType),
        runtime: runtimeFingerprint(owner),
      });
    }
  }

  for (const call of findCalls(sourceFile, clients)) {
    if (!ownedCalls.has(call)) errors.push(`request call at ${position(sourceFile, call)} is not in an exported function`);
  }

  const runtimeImports: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) {
      runtimeImports.push(`side-effect:${statement.moduleSpecifier.text}`);
      continue;
    }
    if (clause.name) runtimeImports.push(`default:${statement.moduleSpecifier.text}`);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) {
          runtimeImports.push(`named:${statement.moduleSpecifier.text}:${element.propertyName?.text ?? element.name.text}`);
        }
      }
    }
  }

  return {
    endpoints,
    exportedTypes: resolver.exportedTypes(),
    exportedValues: resolver.exportedValues(),
    runtimeImports: runtimeImports.sort(),
    errors,
  };
}

export function summarizePolishedSource(source: string): SourceSummary {
  const summary = summarize(source);
  return { endpoints: summary.endpoints, exportedTypes: summary.exportedTypes, errors: summary.errors };
}

export function extractTypeDesign(source: string): string {
  const sourceFile = ts.createSourceFile('previous.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sourceFile.statements
    .filter((statement) => {
      if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) {
        return true;
      }
      return (
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.every(
          (declaration) =>
            !declaration.initializer ||
            (!ts.isArrowFunction(declaration.initializer) &&
              !ts.isFunctionExpression(declaration.initializer)),
        )
      );
    })
    .map((statement) => statement.getText(sourceFile))
    .join('\n\n');
}

function compareShape(before: TypeShape, after: TypeShape, path: string): string[] {
  if (stable(before) === stable(after)) return [];
  if (
    before.kind === 'array' &&
    before.item.kind === 'primitive' &&
    before.item.name === 'unknown' &&
    after.kind === 'array' &&
    !(after.item.kind === 'primitive' && (after.item.name === 'unknown' || after.item.name === 'any'))
  ) {
    return [];
  }
  if (before.kind !== after.kind) {
    return [`${path} changed from ${describe(before)} to ${describe(after)}`];
  }
  if (before.kind === 'object' && after.kind === 'object') {
    const errors: string[] = [];
    const oldFields = new Map(before.fields.map((field) => [field.key, field]));
    const newFields = new Map(after.fields.map((field) => [field.key, field]));
    for (const [key, field] of oldFields) {
      const next = newFields.get(key);
      if (!next) errors.push(`${path}.${key} was removed`);
      else {
        if (field.optional !== next.optional) {
          errors.push(`${path}.${key} optionality changed`);
        }
        if (field.readonly !== next.readonly) {
          errors.push(`${path}.${key} readonly modifier changed`);
        }
        errors.push(...compareShape(field.type, next.type, `${path}.${key}`));
      }
    }
    for (const key of newFields.keys()) {
      if (!oldFields.has(key)) errors.push(`${path}.${key} was added`);
    }
    return errors;
  }
  if (before.kind === 'array' && after.kind === 'array') {
    return compareShape(before.item, after.item, `${path}[]`);
  }
  if (before.kind === 'tuple' && after.kind === 'tuple') {
    if (before.items.length !== after.items.length) return [`${path} tuple length changed`];
    return before.items.flatMap((item, index) => compareShape(item, after.items[index]!, `${path}[${index}]`));
  }
  if (before.kind === 'generic' && after.kind === 'generic') {
    if (before.name !== after.name) return [`${path} wrapper changed from ${before.name} to ${after.name}`];
    if (before.args.length !== after.args.length) return [`${path} generic arity changed`];
    return before.args.flatMap((argument, index) =>
      compareShape(argument, after.args[index]!, `${path}<${index}>`),
    );
  }
  return [`${path} changed from ${describe(before)} to ${describe(after)}`];
}

function describe(shape: TypeShape): string {
  if (shape.kind === 'primitive') return shape.name;
  if (shape.kind === 'literal') return shape.value;
  if (shape.kind === 'array') return `${describe(shape.item)}[]`;
  if (shape.kind === 'generic') return `${shape.name}<${shape.args.map(describe).join(', ')}>`;
  return shape.kind;
}

function endpointDifferences(before: EndpointSummary, after: EndpointSummary): string[] {
  const label = `${before.method} ${before.url}`;
  const errors = [
    ...compareShape(before.request, after.request, `${label} request`),
    ...compareShape(before.response, after.response, `${label} response`),
  ];
  if (before.runtime !== after.runtime) errors.push(`${label} runtime request structure changed`);
  return errors;
}

function compatibleMatches(
  beforeCount: number,
  afterCount: number,
  compatible: (beforeIndex: number, afterIndex: number) => boolean,
): Map<number, number> {
  const afterToBefore = new Map<number, number>();
  const assign = (beforeIndex: number, seen: Set<number>): boolean => {
    for (let afterIndex = 0; afterIndex < afterCount; afterIndex++) {
      if (seen.has(afterIndex) || !compatible(beforeIndex, afterIndex)) continue;
      seen.add(afterIndex);
      const previous = afterToBefore.get(afterIndex);
      if (previous === undefined || assign(previous, seen)) {
        afterToBefore.set(afterIndex, beforeIndex);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < beforeCount; index++) assign(index, new Set());
  return new Map([...afterToBefore].map(([afterIndex, beforeIndex]) => [beforeIndex, afterIndex]));
}

function pairEndpoints(before: EndpointSummary[], after: EndpointSummary[]): string[] {
  if (before.length !== after.length) {
    return [`endpoint count changed from ${before.length} to ${after.length}`];
  }
  const errors: string[] = [];
  for (let index = 0; index < before.length; index++) {
    const oldEndpoint = before[index]!;
    const newEndpoint = after[index]!;
    if (oldEndpoint.method !== newEndpoint.method || oldEndpoint.url !== newEndpoint.url) {
      errors.push(
        `endpoint ${index + 1} changed from ${oldEndpoint.method} ${oldEndpoint.url} to ${newEndpoint.method} ${newEndpoint.url}`,
      );
      continue;
    }
    errors.push(...endpointDifferences(oldEndpoint, newEndpoint));
  }
  return errors;
}

function matchShapes(
  before: { name: string; shape: TypeShape }[],
  after: { name: string; shape: TypeShape }[],
  label: string,
  rejectExtras: boolean,
): string[] {
  const errors: string[] = [];
  const matches = compatibleMatches(before.length, after.length, (beforeIndex, afterIndex) =>
    compareShape(before[beforeIndex]!.shape, after[afterIndex]!.shape, label).length === 0,
  );
  for (let index = 0; index < before.length; index++) {
    if (!matches.has(index)) {
      errors.push(`exported ${label} ${before[index]!.name} has no structurally compatible export`);
    }
  }
  if (rejectExtras) {
    const matchedAfter = new Set(matches.values());
    for (let index = 0; index < after.length; index++) {
      if (!matchedAfter.has(index)) errors.push(`unexpected runtime export ${after[index]!.name}`);
    }
  }
  return errors;
}

export function validatePolishedSource(
  beforeSource: string,
  afterSource: string,
): { ok: boolean; errors: string[] } {
  const before = summarize(beforeSource);
  const after = summarize(afterSource);
  const errors = [
    ...before.errors.map((error) => `before: ${error}`),
    ...after.errors.map((error) => `after: ${error}`),
    ...pairEndpoints(before.endpoints, after.endpoints),
    ...matchShapes(before.exportedTypes, after.exportedTypes, 'type', false),
    ...matchShapes(before.exportedValues, after.exportedValues, 'value', true),
  ];
  if (JSON.stringify(before.runtimeImports) !== JSON.stringify(after.runtimeImports)) {
    errors.push('runtime imports changed');
  }
  return { ok: errors.length === 0, errors };
}

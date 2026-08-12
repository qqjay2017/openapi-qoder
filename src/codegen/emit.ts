// Stage-1 emitter: envelope stripping, pagination detection, named interfaces,
// enum extraction, and request functions.

import { createHash } from 'node:crypto';
import { pascal, pascalFromUrl, singularize } from './naming.js';
import { buildTree, type FieldNode, type RawParam } from './tree.js';
import { collectEnums, emitEnum, emitEnumOptions, type EnumDef } from './enums.js';

export interface TornaDetail {
  /** Torna doc id — the stable identity used to key the naming ledger. */
  id?: string;
  /** Owning project, used to fetch the tree this doc belongs to. */
  projectId?: string;
  /** The docId of the folder holding this doc. */
  parentId?: string;
  docName: string;
  url: string;
  httpMethod: string;
  requestParams: RawParam[];
  responseParams: RawParam[];
}

export interface GenerateOptions {
  /** Import specifier for the shared request client. */
  requestModule?: string;
  /**
   * Import specifier providing `PageResult<T>`. Defaults to a sibling
   * `./common.js`, which the CLI writes next to its output; consumers with their
   * own pagination type should point this at it instead.
   */
  pageResultModule?: string;
  /** Emit the request functions. Off leaves only types/enums. Default true. */
  requestFns?: boolean;
  /** Emit enum consts + types. Off degrades enum fields to their scalar. Default true. */
  enums?: boolean;
  /** Also emit `{ label, value }[]` arrays next to each enum. Default false. */
  options?: boolean;
}

interface ResolvedOptions {
  requestModule: string;
  pageResultModule: string;
  requestFns: boolean;
  enums: boolean;
  options: boolean;
}

function resolveOptions(o: GenerateOptions): ResolvedOptions {
  return {
    requestModule: o.requestModule ?? '@/utils/request',
    pageResultModule: o.pageResultModule ?? './common.js',
    requestFns: o.requestFns ?? true,
    enums: o.enums ?? true,
    options: o.options ?? false,
  };
}

const GATEWAY = new Set(['2m', '2b', '2c']);
const PAGE_ARRAY_NAMES = new Set(['pageobject', 'list', 'records', 'rows']);

// Collapse whitespace/newlines and neutralize block-comment terminators so a
// description can safely sit inside a single-line // or /** */ comment.
function sanitizeComment(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim();
}

// Quote object keys that are not valid JS identifiers (e.g. Torna array-element
// placeholders named "-" or "").
function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function scalarType(t: string): string | null {
  switch (t) {
    case 'string':
    case 'date':
    case 'datetime':
      return 'string';
    case 'int':
    case 'int32':
    case 'int64':
    case 'integer':
    case 'long':
    case 'number':
    case 'double':
    case 'float':
    case 'bigdecimal':
      return 'number';
    case 'boolean':
    case 'bool':
      return 'boolean';
    default:
      return null;
  }
}

interface EmitCtx {
  blocks: string[];
  /**
   * Every top-level name in the file. Value is the field signature for
   * interfaces (so an identical one can be shared) and null for names that can
   * never be shared: type aliases, request functions, enums, imports.
   */
  names: Map<string, string | null>;
  usesPageResult: boolean;
  enums: Map<string, EnumDef>;
  usedEnums: Set<string>;
  /** enumId -> reserved name of its `{label,value}[]` array. */
  optionNames: Map<string, string>;
  opts: ResolvedOptions;
}

// Two sub-objects can mechanically derive the same interface name (`fooBar` and
// `foo_bar` both yield `XFooBar`). Comparing signatures tells us whether that is
// a harmless duplicate or a genuine collision that needs a distinct name.
function fieldsSignature(fields: FieldNode[]): string {
  return JSON.stringify(
    fields.map((f) => [f.name, f.type, f.required ? 1 : 0, f.enumId, fieldsSignature(f.children)]),
  );
}

/** Claim a name that can never be shared: alias, request fn, enum, import. */
function reserveName(base: string, ctx: EmitCtx): string {
  let name = base;
  for (let n = 2; ctx.names.has(name); n++) name = `${base}${n}`;
  ctx.names.set(name, null);
  return name;
}

// Torna names array-element placeholders "-" or "", and singularize() can strip
// a name to nothing ("List", "s"). Either way pascal() returns '' and the
// sub-interface name would collapse onto its owner's.
function subName(ownerName: string, fieldName: string): string {
  return ownerName + (pascal(fieldName) || 'Item');
}

function fieldType(node: FieldNode, ownerName: string, ctx: EmitCtx): string {
  // Enum-typed string fields reference the extracted enum type.
  if (ctx.opts.enums && node.enumId && ctx.enums.has(node.enumId)) {
    const scalar = scalarType(node.type);
    if (scalar === 'string') {
      const def = ctx.enums.get(node.enumId)!;
      ctx.usedEnums.add(node.enumId);
      return def.typeName;
    }
  }

  const scalar = scalarType(node.type);
  if (scalar) return scalar;

  if (node.type === 'object') {
    return emitInterface(subName(ownerName, node.name), node.children, ctx);
  }

  if (node.type === 'array') {
    // Array of objects: children describe the item's fields.
    if (node.children.length > 0) {
      const sub = emitInterface(subName(ownerName, singularize(node.name)), node.children, ctx);
      return `${sub}[]`;
    }
    // Scalar array with no element metadata in Torna. Left honest; Stage-2
    // AI infers the element type from name / description / example.
    return 'unknown[]';
  }

  return 'unknown';
}

/** Emits the interface if needed; returns the name actually used. */
function emitInterface(name: string, fields: FieldNode[], ctx: EmitCtx): string {
  const sig = fieldsSignature(fields);
  let finalName = name;
  for (let n = 2; ; n++) {
    const existing = ctx.names.get(finalName);
    if (existing === undefined) break;
    // null means the name belongs to an alias/fn/enum and can never be shared.
    if (existing === sig) return finalName;
    finalName = `${name}${n}`;
  }
  // Reserve before recursing: nested names must derive from the final name, and
  // a self-referential tree must not loop.
  ctx.names.set(finalName, sig);

  const lines: string[] = [`export interface ${finalName} {`];
  for (const f of fields) {
    const t = fieldType(f, finalName, ctx);
    if (f.description) lines.push(`  /** ${sanitizeComment(f.description)} */`);
    lines.push(`  ${propKey(f.name)}${f.required ? '' : '?'}: ${t};`);
  }
  lines.push('}');
  ctx.blocks.push(lines.join('\n'));
  return finalName;
}

function findDataNode(responseTree: FieldNode[]): FieldNode | undefined {
  return responseTree.find((n) => n.name === 'data');
}

function detectPageArray(dataNode: FieldNode): FieldNode | undefined {
  const hasTotal = dataNode.children.some((c) => c.name.toLowerCase() === 'totalcount');
  if (!hasTotal) return undefined;
  return dataNode.children.find(
    (c) => c.type === 'array' && PAGE_ARRAY_NAMES.has(c.name.toLowerCase()),
  );
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// Request path: drop the gateway prefix (/2m /2b /2c); the proxy re-adds it.
function requestPath(url: string): string {
  const segs = url.split('/').filter(Boolean);
  if (segs.length && GATEWAY.has(segs[0]!.toLowerCase())) segs.shift();
  return `/${segs.join('/')}`;
}

function emitRequestFn(
  detail: TornaDetail,
  fnName: string,
  paramName: string,
  dataName: string,
): string {
  const url = requestPath(detail.url);
  const method = (detail.httpMethod || 'POST').toUpperCase();
  const doc = `/** ${sanitizeComment(detail.docName)} */`;
  if (method === 'GET') {
    return (
      `${doc}\n` +
      `export const ${fnName} = (params: ${paramName}) =>\n` +
      `  request.get<${dataName}, ${paramName}>('${url}', { params });`
    );
  }
  return (
    `${doc}\n` +
    `export const ${fnName} = (data: ${paramName}) =>\n` +
    `  request.${method.toLowerCase()}<${dataName}, ${paramName}>('${url}', data);`
  );
}

// Structural fingerprint of the API shape. Drives incremental polishing:
// unchanged hash => reuse ledger names and skip the AI entirely.
function shapeHash(detail: TornaDetail, reqTree: FieldNode[], respTree: FieldNode[]): string {
  const sig = (nodes: FieldNode[]): unknown =>
    nodes.map((n) => [n.name, n.type, n.required ? 1 : 0, n.enumId, sig(n.children)]);
  const payload = JSON.stringify([
    detail.httpMethod,
    detail.url,
    sig(reqTree),
    sig(respTree),
  ]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 12);
}

function createCtx(params: RawParam[], opts: ResolvedOptions): EmitCtx {
  const ctx: EmitCtx = {
    blocks: [],
    names: new Map(),
    usesPageResult: false,
    enums: opts.enums ? collectEnums(params) : new Map(),
    usedEnums: new Set(),
    optionNames: new Map(),
    opts,
  };
  // The file imports these, so no generated type may shadow them.
  ctx.names.set('request', null);
  ctx.names.set('PageResult', null);
  // Enum names come from collectEnums and are referenced by fieldType, so claim
  // them up front. Two different enumIds can derive the same name; reserveName
  // hands the second one a distinct one instead of emitting a duplicate.
  for (const [enumId, def] of ctx.enums) {
    def.typeName = reserveName(def.typeName, ctx);
    def.constName = reserveName(def.constName, ctx);
    if (opts.options) {
      ctx.optionNames.set(enumId, reserveName(`${def.constName}_OPTIONS`, ctx));
    }
  }
  return ctx;
}

interface ApiParts {
  docId: string;
  url: string;
  shape: string;
  /** Interfaces this API added to the shared context. */
  blocks: string[];
  aliases: string[];
  requestFn: string | null;
  /** `// METHOD /url  docName` provenance line. */
  comment: string;
}

function emitApi(detail: TornaDetail, ctx: EmitCtx): ApiParts {
  const base = pascalFromUrl(detail.url, detail.docName);
  const firstBlock = ctx.blocks.length;

  // --- Request params -> <Base>Param ---
  const reqTree = buildTree(detail.requestParams ?? []);
  const paramName = emitInterface(`${base}Param`, reqTree, ctx);

  // --- Response data (envelope stripped) -> <Base>Data ---
  const respTree = buildTree(detail.responseParams ?? []);
  const dataNode = findDataNode(respTree);
  const aliases: string[] = [];
  let dataName: string;

  if (!dataNode) {
    dataName = reserveName(`${base}Data`, ctx);
    aliases.push(`export type ${dataName} = unknown;`);
  } else if (dataNode.type === 'object') {
    const pageArray = detectPageArray(dataNode);
    if (pageArray) {
      const itemName = emitInterface(`${base}Item`, pageArray.children, ctx);
      ctx.usesPageResult = true;
      dataName = reserveName(`${base}Data`, ctx);
      aliases.push(`export type ${dataName} = PageResult<${itemName}>;`);
    } else {
      dataName = emitInterface(`${base}Data`, dataNode.children, ctx);
    }
  } else if (dataNode.type === 'array') {
    const itemName = emitInterface(`${base}Item`, dataNode.children, ctx);
    dataName = reserveName(`${base}Data`, ctx);
    aliases.push(`export type ${dataName} = ${itemName}[];`);
  } else {
    const scalar = scalarType(dataNode.type) ?? 'unknown';
    dataName = reserveName(`${base}Data`, ctx);
    aliases.push(`export type ${dataName} = ${scalar};`);
  }

  const fnName = ctx.opts.requestFns ? reserveName(lowerFirst(base), ctx) : null;
  return {
    docId: detail.id ?? '-',
    url: detail.url,
    shape: shapeHash(detail, reqTree, respTree),
    blocks: ctx.blocks.slice(firstBlock),
    aliases,
    requestFn: fnName ? emitRequestFn(detail, fnName, paramName, dataName) : null,
    comment: `// ${detail.httpMethod} ${detail.url}  ${sanitizeComment(detail.docName)}`,
  };
}

function assemble(header: string, sections: string[], ctx: EmitCtx): string {
  const enumBlocks = [...ctx.usedEnums].flatMap((id) => {
    const def = ctx.enums.get(id)!;
    const optionsName = ctx.optionNames.get(id);
    return optionsName ? [emitEnum(def), emitEnumOptions(def, optionsName)] : [emitEnum(def)];
  });
  const imports =
    (ctx.opts.requestFns ? `import request from '${ctx.opts.requestModule}';\n` : '') +
    (ctx.usesPageResult ? `import type { PageResult } from '${ctx.opts.pageResultModule}';\n` : '');
  return (
    [header + imports, ...enumBlocks, ...sections]
      .filter(Boolean)
      .join('\n\n')
      .trimEnd() + '\n'
  );
}

export function generateFile(detail: TornaDetail, options: GenerateOptions = {}): string {
  const opts = resolveOptions(options);
  const ctx = createCtx([...(detail.requestParams ?? []), ...(detail.responseParams ?? [])], opts);
  const api = emitApi(detail, ctx);
  const header =
    `// AUTO-GENERATED by openapi-qoder Stage-1. Do not edit by hand.\n` +
    `${api.comment}\n` +
    `// docId: ${api.docId}  shape: ${api.shape}\n`;
  const sections = [...api.blocks, ...api.aliases, api.requestFn].filter(
    (s): s is string => !!s,
  );
  return assemble(header, sections, ctx);
}

export interface FolderInfo {
  /** The folder's own Torna docId — this keys the ledger entry for the file. */
  docId: string;
  label: string;
}

// The sibling list is part of the hash on purpose: adding or removing an API, or
// changing a URL, shifts the numeric name suffixes. Folding it in guarantees any
// such shift surfaces as a shape change, so the ledger discards its now-
// misaligned name map instead of renaming the wrong declaration.
function folderShapeHash(apis: ApiParts[]): string {
  const payload = JSON.stringify(apis.map((a) => [a.docId, a.url, a.shape]));
  return createHash('sha256').update(payload).digest('hex').slice(0, 12);
}

/**
 * Emit every API of one Torna folder into a single file. One shared context
 * means shared enums are declared once and colliding twin APIs (`/2m/x/y` and
 * `/2b/x/y` derive the same base name) get distinct names.
 */
export function generateFolderFile(
  details: TornaDetail[],
  folder: FolderInfo,
  options: GenerateOptions = {},
): string {
  // Deterministic order, independent of how Torna happens to sort the tree:
  // this is what makes the numeric name suffixes reproducible.
  const sorted = [...details].sort(
    (x, y) => x.url.localeCompare(y.url) || (x.id ?? '').localeCompare(y.id ?? ''),
  );
  const allParams = sorted.flatMap((d) => [
    ...(d.requestParams ?? []),
    ...(d.responseParams ?? []),
  ]);
  const ctx = createCtx(allParams, resolveOptions(options));
  const apis = sorted.map((d) => emitApi(d, ctx));

  const header =
    `// AUTO-GENERATED by openapi-qoder Stage-1. Do not edit by hand.\n` +
    `// 目录 ${sanitizeComment(folder.label)}  (${apis.length} API(s))\n` +
    `// docId: ${folder.docId}  shape: ${folderShapeHash(apis)}\n` +
    `// apiShapes: ${apis.map((a) => `${a.docId}=${a.shape}`).join(' ')}\n`;
  const sections = apis.map((a) =>
    [a.comment, ...a.blocks, ...a.aliases, a.requestFn].filter(Boolean).join('\n\n'),
  );
  return assemble(header, sections, ctx);
}

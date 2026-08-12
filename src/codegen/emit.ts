// Stage-1 emitter: envelope stripping, pagination detection, named interfaces,
// enum extraction, and request functions.

import { createHash } from 'node:crypto';
import { pascal, pascalFromUrl, singularize } from './naming.js';
import { buildTree, type FieldNode, type RawParam } from './tree.js';
import { collectEnums, emitEnum, type EnumDef } from './enums.js';

export interface TornaDetail {
  /** Torna doc id — the stable identity used to key the naming ledger. */
  id?: string;
  docName: string;
  url: string;
  httpMethod: string;
  requestParams: RawParam[];
  responseParams: RawParam[];
}

export interface GenerateOptions {
  /** Import specifier for the shared request client. */
  requestModule?: string;
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
  /** interface name -> signature of the fields it was emitted from. */
  emitted: Map<string, string>;
  usesPageResult: boolean;
  enums: Map<string, EnumDef>;
  usedEnums: Set<string>;
}

// Two sub-objects can mechanically derive the same interface name (`fooBar` and
// `foo_bar` both yield `XFooBar`). Comparing signatures tells us whether that is
// a harmless duplicate or a genuine collision that needs a distinct name.
function fieldsSignature(fields: FieldNode[]): string {
  return JSON.stringify(
    fields.map((f) => [f.name, f.type, f.required ? 1 : 0, f.enumId, fieldsSignature(f.children)]),
  );
}

// Torna names array-element placeholders "-" or "", and singularize() can strip
// a name to nothing ("List", "s"). Either way pascal() returns '' and the
// sub-interface name would collapse onto its owner's.
function subName(ownerName: string, fieldName: string): string {
  return ownerName + (pascal(fieldName) || 'Item');
}

function fieldType(node: FieldNode, ownerName: string, ctx: EmitCtx): string {
  // Enum-typed string fields reference the extracted enum type.
  if (node.enumId && ctx.enums.has(node.enumId)) {
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
    const existing = ctx.emitted.get(finalName);
    if (existing === undefined) break;
    if (existing === sig) return finalName;
    finalName = `${name}${n}`;
  }
  // Reserve before recursing: nested names must derive from the final name, and
  // a self-referential tree must not loop.
  ctx.emitted.set(finalName, sig);

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
  base: string,
  paramName: string,
  dataName: string,
): string {
  const fnName = lowerFirst(base);
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

export function generateFile(detail: TornaDetail, options: GenerateOptions = {}): string {
  const requestModule = options.requestModule ?? '@/utils/request';
  const base = pascalFromUrl(detail.url, detail.docName);
  const allParams = [...(detail.requestParams ?? []), ...(detail.responseParams ?? [])];
  const ctx: EmitCtx = {
    blocks: [],
    emitted: new Map(),
    usesPageResult: false,
    enums: collectEnums(allParams),
    usedEnums: new Set(),
  };

  // --- Request params -> <Base>Param ---
  const reqTree = buildTree(detail.requestParams ?? []);
  const paramName = emitInterface(`${base}Param`, reqTree, ctx);

  // --- Response data (envelope stripped) -> <Base>Data ---
  const respTree = buildTree(detail.responseParams ?? []);
  const dataNode = findDataNode(respTree);
  let dataName = `${base}Data`;
  const dataAliases: string[] = [];

  if (!dataNode) {
    dataAliases.push(`export type ${dataName} = unknown;`);
  } else if (dataNode.type === 'object') {
    const pageArray = detectPageArray(dataNode);
    if (pageArray) {
      const itemName = emitInterface(`${base}Item`, pageArray.children, ctx);
      ctx.usesPageResult = true;
      dataAliases.push(`export type ${dataName} = PageResult<${itemName}>;`);
    } else {
      dataName = emitInterface(dataName, dataNode.children, ctx);
    }
  } else if (dataNode.type === 'array') {
    const itemName = emitInterface(`${base}Item`, dataNode.children, ctx);
    dataAliases.push(`export type ${dataName} = ${itemName}[];`);
  } else {
    const scalar = scalarType(dataNode.type) ?? 'unknown';
    dataAliases.push(`export type ${dataName} = ${scalar};`);
  }

  // --- Enum declarations (only those actually referenced) ---
  const enumBlocks = [...ctx.usedEnums]
    .map((id) => ctx.enums.get(id)!)
    .map((def) => emitEnum(def));

  // --- Request function ---
  const requestFn = emitRequestFn(detail, base, paramName, dataName);

  // --- Assemble file ---
  const header =
    `// AUTO-GENERATED by openapi-qoder Stage-1. Do not edit by hand.\n` +
    `// ${detail.httpMethod} ${detail.url}  ${sanitizeComment(detail.docName)}\n` +
    `// docId: ${detail.id ?? '-'}  shape: ${shapeHash(detail, reqTree, respTree)}\n`;
  const imports =
    `import request from '${requestModule}';\n` +
    (ctx.usesPageResult ? `import type { PageResult } from './common.js';\n` : '');

  return (
    [header + imports, ...enumBlocks, ...ctx.blocks, ...dataAliases, requestFn]
      .filter(Boolean)
      .join('\n\n')
      .trimEnd() + '\n'
  );
}

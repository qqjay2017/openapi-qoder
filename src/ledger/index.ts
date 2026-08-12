// Naming ledger: persists Stage-2 decisions so later runs are reproducible and
// incremental.
//
// Why this exists: the AI polish is not deterministic. Re-running it would drift
// type/function names and break every page that imports them. So we separate
// DECISIONS (this ledger, committed to git) from the ARTIFACT (generated files).
//
//   Stage 1  mechanical names      (deterministic)
//   Stage 1.5 apply ledger         (deterministic, no AI)
//   Stage 2  AI fills gaps only    (cost scales with doc churn, not API count)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseFile, type FileShape } from './parse.js';

export interface LedgerFn {
  /** Mechanical name when recorded. Replay verifies it still exists first. */
  mechanical: string;
  semantic: string;
  /** Frozen: consumers import this name, so it survives a shape change. */
  locked?: boolean;
}

export interface ApiLedgerEntry {
  url: string;
  httpMethod: string;
  /** 'api' = one Torna doc; 'folder' = a whole Torna folder merged into one file. */
  kind: 'api' | 'folder';
  /** Structural fingerprint at the time decisions were made. */
  shape: string;
  /** docId -> shape, folder entries only. Lets `status` name the drifting API. */
  apiShapes?: Record<string, string>;
  /** mechanical type name -> semantic type name */
  types: Record<string, string>;
  /** docId -> request function rename */
  fns: Record<string, LedgerFn>;
  /** "MechanicalOwner.propKey" -> resolved TS type (scalar array inference) */
  fieldTypes: Record<string, string>;
  /** 'ai' | 'manual' — manual entries are never overwritten by the AI. */
  source: 'ai' | 'manual';
}

export interface Ledger {
  version: number;
  apis: Record<string, ApiLedgerEntry>;
}

export function emptyLedger(): Ledger {
  return { version: 1, apis: {} };
}

export function loadLedger(file: string): Ledger {
  if (!existsSync(file)) return emptyLedger();
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Ledger>;
  return { version: raw.version ?? 1, apis: raw.apis ?? {} };
}

export function saveLedger(file: string, ledger: Ledger): void {
  mkdirSync(dirname(file), { recursive: true });
  const sorted: Ledger = { version: ledger.version, apis: {} };
  for (const key of Object.keys(ledger.apis).sort()) sorted.apis[key] = ledger.apis[key]!;
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * Derive ledger decisions by pairing a Stage-1 file with its polished result.
 * Used to bootstrap the ledger from an existing polish run.
 */
export function harvestEntry(
  stage1: string,
  polished: string,
  meta: { url: string; httpMethod: string },
): ApiLedgerEntry | null {
  const a: FileShape = parseFile(stage1);
  const b: FileShape = parseFile(polished);
  if (a.docId === '-') return null;

  // Structure must line up, otherwise Stage-2 broke its contract and we refuse
  // to record anything rather than persist a bad mapping.
  if (a.interfaces.length !== b.interfaces.length || a.aliases.length !== b.aliases.length) {
    return null;
  }

  const types: Record<string, string> = {};
  const fieldTypes: Record<string, string> = {};

  for (let i = 0; i < a.interfaces.length; i++) {
    const ia = a.interfaces[i]!;
    const ib = b.interfaces[i]!;
    if (ia.props.length !== ib.props.length) return null;
    if (ia.name !== ib.name) types[ia.name] = ib.name;

    for (let j = 0; j < ia.props.length; j++) {
      const pa = ia.props[j]!;
      const pb = ib.props[j]!;
      if (pa.key !== pb.key || pa.optional !== pb.optional) return null;
      // Only record genuine inference wins on previously-unknown arrays.
      if (pa.type !== pb.type && /unknown\[\]/.test(pa.type)) {
        fieldTypes[`${ia.name}.${pa.key}`] = pb.type;
      }
    }
  }

  for (let i = 0; i < a.aliases.length; i++) {
    const aa = a.aliases[i]!;
    const ab = b.aliases[i]!;
    if (aa.name !== ab.name) types[aa.name] = ab.name;
  }

  // One request fn per API, emitted in member order — that is what pairs a
  // rename to its docId.
  if (a.fnNames.length !== b.fnNames.length) return null;
  const members = a.members.length > 0 ? a.members : [{ docId: a.docId, shape: a.shape }];
  if (a.fnNames.length !== members.length) return null;

  const fns: Record<string, LedgerFn> = {};
  for (let i = 0; i < a.fnNames.length; i++) {
    const mechanical = a.fnNames[i]!;
    const semantic = b.fnNames[i]!;
    if (mechanical !== semantic) {
      fns[members[i]!.docId] = { mechanical, semantic, locked: true };
    }
  }

  // Two declarations renamed to the same thing cannot compile. Stage-2's tsc gate
  // catches it once; recording it would make every later run replay the breakage.
  const targets = [...Object.values(types), ...Object.values(fns).map((f) => f.semantic)];
  if (new Set(targets).size !== targets.length) return null;
  const renamed = new Set(Object.keys(types));
  const untouched = new Set(
    [...a.interfaces.map((i) => i.name), ...a.aliases.map((al) => al.name)].filter(
      (n) => !renamed.has(n),
    ),
  );
  if (Object.values(types).some((t) => untouched.has(t))) return null;

  const entry: ApiLedgerEntry = {
    url: meta.url,
    httpMethod: meta.httpMethod,
    kind: a.members.length > 0 ? 'folder' : 'api',
    shape: a.shape,
    types,
    fns,
    fieldTypes,
    source: 'ai',
  };
  if (a.members.length > 0) {
    entry.apiShapes = Object.fromEntries(a.members.map((m) => [m.docId, m.shape]));
  }
  return entry;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rename identifiers in one pass. Going one-by-one would corrupt chains where a
 * rename's target is another rename's source (`XParam`->`YParam`, `X2Param`->
 * `XParam`), which merged folder files hit routinely because twin APIs produce
 * `XParam` and `X2Param`. Word boundaries guarantee no source name matches
 * inside another identifier, so the substitution order does not matter.
 */
function applyRenames(source: string, renames: [from: string, to: string][]): string {
  if (renames.length === 0) return source;
  let out = source;
  const expand: [placeholder: string, to: string][] = [];
  renames.forEach(([from, to], i) => {
    const placeholder = `\u0000${i}\u0000`;
    expand.push([placeholder, to]);
    out = out.replace(new RegExp(`\\b${escapeRe(from)}\\b`, 'g'), placeholder);
  });
  for (const [placeholder, to] of expand) out = out.split(placeholder).join(to);
  return out;
}

/**
 * Deterministically re-apply recorded decisions to freshly generated Stage-1
 * output. No AI involved.
 */
export function applyEntry(stage1Source: string, entry: ApiLedgerEntry): string {
  let out = stage1Source;

  // Field-level type overrides first: they are keyed by MECHANICAL owner names,
  // which are still intact before renaming happens.
  for (const [path, type] of Object.entries(entry.fieldTypes)) {
    const dot = path.lastIndexOf('.');
    const owner = escapeRe(path.slice(0, dot));
    const key = escapeRe(path.slice(dot + 1));
    const ownerRe = new RegExp(`(export interface ${owner} \\{[\\s\\S]*?\\n\\})`, 'm');
    out = out.replace(ownerRe, (block) =>
      block.replace(
        new RegExp(`(^\\s{2}(?:["']?)${key}(?:["']?)\\??:\\s*)unknown\\[\\](;)`, 'm'),
        (_full, prefix: string, semi: string) => `${prefix}${type}${semi}`,
      ),
    );
  }

  const renames: [string, string][] = Object.entries(entry.types);
  const present = new Set(parseFile(stage1Source).fnNames);
  for (const fn of Object.values(entry.fns)) {
    // Gone means the suffix shifted or the API was removed; renaming by position
    // would silently rename the wrong function.
    if (present.has(fn.mechanical)) renames.push([fn.mechanical, fn.semantic]);
  }
  return applyRenames(out, renames);
}

/** Fields still unresolved after applying the ledger — the AI's actual work list. */
export function pendingWork(source: string): { unknownArrays: number } {
  return { unknownArrays: (source.match(/unknown\[\]/g) ?? []).length };
}

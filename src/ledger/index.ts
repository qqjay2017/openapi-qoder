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

export interface ApiLedgerEntry {
  url: string;
  httpMethod: string;
  /** Structural fingerprint at the time decisions were made. */
  shape: string;
  /** mechanical type name -> semantic type name */
  types: Record<string, string>;
  /** mechanical request fn name -> semantic fn name */
  fn?: string;
  /** "MechanicalOwner.propKey" -> resolved TS type (scalar array inference) */
  fieldTypes: Record<string, string>;
  /** 'ai' | 'manual' — manual entries are never overwritten by the AI. */
  source: 'ai' | 'manual';
  /** Once true, the fn name is frozen: consumers import it by name. */
  locked?: boolean;
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

  const entry: ApiLedgerEntry = {
    url: meta.url,
    httpMethod: meta.httpMethod,
    shape: a.shape,
    types,
    fieldTypes,
    source: 'ai',
  };
  if (a.fnName && b.fnName && a.fnName !== b.fnName) {
    entry.fn = b.fnName;
    entry.locked = true;
  }
  return entry;
}

function replaceIdentifier(source: string, from: string, to: string): string {
  return source.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
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
    const owner = path.slice(0, dot);
    const key = path.slice(dot + 1);
    const ownerRe = new RegExp(
      `(export interface ${owner} \\{[\\s\\S]*?\\n\\})`,
      'm',
    );
    out = out.replace(ownerRe, (block) =>
      block.replace(
        new RegExp(`(^\\s{2}(?:["']?)${key}(?:["']?)\\??:\\s*)unknown\\[\\](;)`, 'm'),
        `$1${type}$2`,
      ),
    );
  }

  // Longest-first so `XPageParam` is not partially rewritten by `XPage`.
  for (const from of Object.keys(entry.types).sort((x, y) => y.length - x.length)) {
    out = replaceIdentifier(out, from, entry.types[from]!);
  }
  if (entry.fn) {
    const current = parseFile(stage1Source).fnName;
    if (current) out = replaceIdentifier(out, current, entry.fn);
  }
  return out;
}

/** Fields still unresolved after applying the ledger — the AI's actual work list. */
export function pendingWork(source: string): { unknownArrays: number } {
  return { unknownArrays: (source.match(/unknown\[\]/g) ?? []).length };
}

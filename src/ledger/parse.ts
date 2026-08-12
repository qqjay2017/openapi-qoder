// Lightweight structural reader for generated files.
//
// Stage-1 emits declarations in a fixed order and Stage-2 is contractually
// forbidden from adding/removing/reordering them, so pairing a Stage-1 file
// with its polished counterpart by declaration index is reliable.

export interface PropInfo {
  key: string;
  optional: boolean;
  type: string;
}

export interface InterfaceInfo {
  name: string;
  props: PropInfo[];
}

export interface FileShape {
  docId: string;
  shape: string;
  interfaces: InterfaceInfo[];
  /** `export type X = ...` aliases, in order. */
  aliases: { name: string; rhs: string }[];
  /** The exported request function name, if present. */
  fnName: string | null;
}

const PROP_RE = /^\s{2}(?:\/\*\*.*\*\/\s*)?(["']?)([A-Za-z0-9_$ -]+)\1(\?)?:\s*(.+?);\s*$/;

export function parseHeader(source: string): { docId: string; shape: string } {
  const m = /^\/\/ docId:\s*(\S+)\s+shape:\s*(\S+)\s*$/m.exec(source);
  return m ? { docId: m[1]!, shape: m[2]! } : { docId: '-', shape: '' };
}

export function parseFile(source: string): FileShape {
  const { docId, shape } = parseHeader(source);
  const lines = source.split('\n');

  const interfaces: InterfaceInfo[] = [];
  const aliases: { name: string; rhs: string }[] = [];
  let fnName: string | null = null;

  let current: InterfaceInfo | null = null;
  for (const line of lines) {
    const ifaceStart = /^export interface (\w+) \{/.exec(line);
    if (ifaceStart) {
      current = { name: ifaceStart[1]!, props: [] };
      interfaces.push(current);
      continue;
    }
    if (current) {
      if (/^\}/.test(line)) {
        current = null;
        continue;
      }
      const p = PROP_RE.exec(line);
      if (p) current.props.push({ key: p[2]!, optional: !!p[3], type: p[4]! });
      continue;
    }
    const alias = /^export type (\w+) = (.+);$/.exec(line);
    if (alias) {
      aliases.push({ name: alias[1]!, rhs: alias[2]! });
      continue;
    }
    // Request function: `export const name = (data: X) =>` — enums use `= {`.
    const fn = /^export const (\w+) = \(/.exec(line);
    if (fn) fnName = fn[1]!;
  }

  return { docId, shape, interfaces, aliases, fnName };
}

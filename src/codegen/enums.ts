// Stage-1 enum extraction.
//
// Torna carries enum metadata in two overlapping places:
//   1. param.description: "...[Enum: PERSONAL(\"CUSTOMER_TYPE_C\", \"个人\")<br/>, ...]"
//      -> authoritative KEY + VALUE (enumInfo.items[].value is often a placeholder
//         equal to the name and cannot be trusted).
//   2. param.enumInfo.items[]: { name, value, description }
//      -> best source for the human (Chinese) label per key.
//
// So we take KEY+VALUE from the description block and prefer the label from items.

import type { EnumInfo, RawParam } from './tree.js';
import { pascal } from './naming.js';

export interface EnumMember {
  key: string;
  value: string;
  label: string;
}

export interface EnumDef {
  enumId: string;
  constName: string; // SCREAMING_SNAKE_CASE
  typeName: string; // PascalCase
  members: EnumMember[];
}

const ENUM_MEMBER_RE = /(\w+)\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g;

interface ParsedMember {
  key: string;
  value: string;
  label: string;
}

function parseEnumString(desc: string | undefined): ParsedMember[] {
  if (!desc) return [];
  const out: ParsedMember[] = [];
  for (const m of desc.matchAll(ENUM_MEMBER_RE)) {
    out.push({ key: m[1]!, value: m[2]!, label: m[3]! });
  }
  return out;
}

function stripListSuffix(name: string): string {
  return name.replace(/List$/, '');
}

function screaming(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
}

function buildMembers(param: RawParam, info: EnumInfo): EnumMember[] {
  const labelByKey = new Map<string, string>();
  for (const it of info.items ?? []) {
    if (it.description) labelByKey.set(it.name, it.description);
  }

  const fromDesc = parseEnumString(param.description ?? info.description);
  if (fromDesc.length > 0) {
    return fromDesc.map((m) => ({
      key: m.key,
      value: m.value,
      label: labelByKey.get(m.key) ?? m.label,
    }));
  }

  // Fallback: no [Enum: ...] block — trust items as-is.
  return (info.items ?? []).map((it) => ({
    key: it.name,
    value: String(it.value),
    label: it.description ?? '',
  }));
}

// Scan all params; register each enum once (keyed by enumId). Naming derives
// from the defining field name (List/plural stripped) so `bizType` and
// `bizTypeList` collapse to the same BIZ_TYPE / BizType.
export function collectEnums(params: RawParam[]): Map<string, EnumDef> {
  const registry = new Map<string, EnumDef>();
  for (const p of params) {
    const info = p.enumInfo;
    if (!p.enumId || !info || !info.items || info.items.length === 0) continue;
    if (registry.has(p.enumId)) continue;

    const members = buildMembers(p, info);
    if (members.length === 0) continue;

    const base = stripListSuffix(p.name);
    registry.set(p.enumId, {
      enumId: p.enumId,
      constName: screaming(base),
      typeName: pascal(base),
      members,
    });
  }
  return registry;
}

function sanitizeLabel(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim();
}

function singleQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function emitEnum(def: EnumDef): string {
  const lines: string[] = [`export const ${def.constName} = {`];
  for (const m of def.members) {
    if (m.label) lines.push(`  /** ${sanitizeLabel(m.label)} */`);
    lines.push(`  ${m.key}: ${singleQuote(m.value)},`);
  }
  lines.push('} as const;');
  lines.push(
    `export type ${def.typeName} = typeof ${def.constName}[keyof typeof ${def.constName}];`,
  );
  return lines.join('\n');
}

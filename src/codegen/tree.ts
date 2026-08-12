// Rebuild the nested field tree from Torna's flat params linked by id / parentId.

export interface EnumItem {
  name: string;
  value: string | number;
  description?: string;
}

export interface EnumInfo {
  id: string;
  name?: string;
  description?: string;
  items: EnumItem[];
}

export interface RawParam {
  id: string;
  parentId: string;
  name: string;
  type: string;
  required?: number;
  description?: string;
  style?: number;
  enumId?: string;
  enumInfo?: EnumInfo | null;
}

export interface FieldNode {
  name: string;
  /** normalized lowercase torna type: string | int32 | object | array | ... */
  type: string;
  required: boolean;
  description: string;
  enumId: string;
  children: FieldNode[];
}

function cleanDesc(desc?: string): string {
  const t = (desc ?? '').trim();
  if (t === '' || t === 'No comments found.') return '';
  return t;
}

export function buildTree(params: RawParam[]): FieldNode[] {
  const childrenOf = new Map<string, RawParam[]>();
  for (const p of params) {
    const key = p.parentId || '';
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(p);
    else childrenOf.set(key, [p]);
  }

  const build = (parentKey: string): FieldNode[] =>
    (childrenOf.get(parentKey) ?? []).map((p) => ({
      name: p.name,
      type: (p.type || 'string').toLowerCase(),
      required: p.required === 1,
      description: cleanDesc(p.description),
      enumId: p.enumId || '',
      children: build(p.id),
    }));

  return build('');
}

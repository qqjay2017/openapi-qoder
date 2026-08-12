// Logic shared by the CLI and the VS Code extension.
//
// Everything here is pure: no fs, no process, no network. The extension bundles
// this module, so it must not reach for a repo checkout or an env var.

import type { ApiTreeNode } from '../torna/client.js';

const GATEWAY = new Set(['2m', '2b', '2c']);

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (i: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** URL path segments, minus the gateway (`2m`/`2b`/`2c`) and version parts. */
export function urlSegments(url: string): string[] {
  return url
    .split('/')
    .filter(Boolean)
    .filter((s) => !GATEWAY.has(s.toLowerCase()))
    .filter((s) => !/^v\d/i.test(s));
}

export function slugFromUrl(url: string, fallback: string): string {
  const slug = urlSegments(url)
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
}

/**
 * Filename for a merged folder file: the longest URL segment prefix every API
 * shares. Gateway/version segments are dropped first — otherwise a folder of
 * 2m/2b twins diverges at segment 1 and the prefix is always empty.
 */
export function commonSlug(urls: string[], fallback: string): string {
  const segLists = urls.map(urlSegments);
  const first = segLists[0] ?? [];
  const shared: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]!;
    if (!segLists.every((segs) => segs[i] === seg)) break;
    shared.push(seg);
  }
  return slugFromUrl(shared.join('/'), fallback);
}

/**
 * Locate the folder holding `docId`. `detail.parentId` is the folder's *docId*,
 * while the folder's children point at its separate 32-char `id`, so both keys
 * are needed. Falls back to the leaf's own parentId, which is that same id.
 */
export function findFolder(
  tree: ApiTreeNode[],
  docId: string,
  parentDocId: string | undefined,
): { docId: string; label: string; id: string } | null {
  const node = parentDocId ? tree.find((n) => n.docId === parentDocId) : undefined;
  if (node) return { docId: node.docId!, label: node.label, id: node.id };
  const leaf = tree.find((n) => n.docId === docId);
  const byId = leaf ? tree.find((n) => n.id === leaf.parentId) : undefined;
  if (byId) return { docId: byId.docId ?? byId.id, label: byId.label, id: byId.id };
  return null;
}

export interface ParsedDocUrl {
  /** Origin to use as the Torna base URL, or null when a bare id was given. */
  baseUrl: string | null;
  /** The doc id from the `#/view/<id>` route. */
  id: string;
}

/**
 * Accepts a Torna doc URL (`https://host/#/view/K8MmPR78`) or a bare docId.
 * Taking the base URL from the pasted link means there is no separate host to
 * configure.
 */
export function parseDocUrl(input: string): ParsedDocUrl | null {
  const text = input.trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) {
    return /^[A-Za-z0-9_-]+$/.test(text) ? { baseUrl: null, id: text } : null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // Torna uses a hash route, so the id is not in url.pathname.
  const candidates = [...url.hash.replace(/^#/, '').split('/'), ...url.pathname.split('/')];
  const id = candidates.filter(Boolean).pop();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return { baseUrl: url.origin, id };
}

export interface TreeNode {
  id: string;
  docId: string | null;
  label: string;
  url: string;
  httpMethod: string;
  /** 1 = service group, 2 = folder, 3 = api leaf. */
  type: number;
  apiCount: number;
  children: TreeNode[];
}

/**
 * Nest the flat `dataByProject` node list. Children reference a parent's `id`
 * (not its docId); anything whose parentId matches no known id is a root.
 */
export function buildFolderTree(nodes: ApiTreeNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) {
    byId.set(n.id, {
      id: n.id,
      docId: n.docId,
      label: n.label,
      url: n.url,
      httpMethod: n.httpMethod,
      type: n.type,
      apiCount: n.apiCount,
      children: [],
    });
  }
  const roots: TreeNode[] = [];
  for (const n of nodes) {
    const self = byId.get(n.id)!;
    const parent = byId.get(n.parentId);
    if (parent) parent.children.push(self);
    else roots.push(self);
  }
  return roots;
}

/** Every API leaf under `node`, depth-first. */
export function collectApis(node: TreeNode): TreeNode[] {
  if (node.type === 3) return node.docId ? [node] : [];
  return node.children.flatMap(collectApis);
}

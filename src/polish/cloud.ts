// Qoder Cloud Agents REST client for the Stage-2 polish pass.
//
// Auth is a personal access token (`pt-...`) from https://qoder.com/account/integrations.
// The cloud sandbox cannot see the local workspace, so the agent gets no tools:
// the exchange is one text turn in, one text turn out, and the caller writes the
// files. Kept free of `vscode` imports so it runs under plain node/tsx too.

import { POLISH_RULES, type CloudPolishTarget } from './prompt.js';
import { parseFile } from '../ledger/parse.js';

const API_BASE = 'https://api.qoder.com/api/v1/cloud';
const RESOURCE_NAME = 'openapi-qoder-polish';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface CloudIds {
  agentId: string;
  environmentId: string;
}

/** Where the provisioned agent/environment IDs are remembered between runs. */
export interface CloudIdStore {
  get(): CloudIds | undefined;
  set(ids: CloudIds): Promise<void>;
}

type Log = (msg: string) => void;

async function call(
  pat: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) throw await apiError(res, `${method} ${path}`);
  return res.json();
}

// The API answers with `{type:'error', error:{type, message}}`; surface that
// message rather than a bare status code, and name the one failure a user can
// actually fix themselves.
async function apiError(res: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    const body: any = await res.json();
    detail = body?.error?.message ?? '';
  } catch {
    /* non-JSON body */
  }
  if (res.status === 401) {
    return new Error(`Qoder 个人访问令牌无效或已过期${detail ? `：${detail}` : ''}`);
  }
  return new Error(`${what} 失败 (HTTP ${res.status})${detail ? `：${detail}` : ''}`);
}

async function pickModel(pat: string): Promise<string | { id: string; effort: string }> {
  const list = await call(pat, 'GET', '/models');
  const models: any[] = list?.data ?? [];
  const enabled = models.filter((m) => m?.is_enabled !== false);
  const chosen = enabled.find((m) => m.id === 'ultimate') ?? enabled[0];
  if (!chosen?.id) throw new Error('账号下没有可用模型');
  // Renaming does not need deep reasoning; drop to medium effort when the model
  // offers it, otherwise let the service apply its own default.
  return Array.isArray(chosen.efforts) && chosen.efforts.includes('medium')
    ? { id: chosen.id, effort: 'medium' }
    : chosen.id;
}

// Look up a resource we previously provisioned. The list endpoints have no name
// filter, so page through them. This — not an idempotency key — is what keeps
// re-provisioning idempotent: a reused key is rejected with 409, and the cached
// IDs are gone whenever globalState is cleared or another machine runs first.
async function findByName(
  pat: string,
  resource: '/agents' | '/environments',
  name: string,
): Promise<string | undefined> {
  let page: string | undefined;
  // Bounded so a large account cannot spin here forever.
  for (let i = 0; i < 10; i++) {
    const query = `?limit=100${page ? `&page=${encodeURIComponent(page)}` : ''}`;
    const res = await call(pat, 'GET', `${resource}${query}`);
    const hit = (res?.data ?? []).find((r: any) => r?.name === name);
    if (hit?.id) return hit.id;
    if (!res?.has_more || !res?.next_page) return undefined;
    page = res.next_page;
  }
  return undefined;
}

export async function ensureCloudIds(
  pat: string,
  store: CloudIdStore,
  log: Log,
): Promise<CloudIds> {
  const cached = store.get();
  if (cached?.agentId && cached?.environmentId) return cached;

  let environmentId = await findByName(pat, '/environments', RESOURCE_NAME);
  if (environmentId) {
    log(`[cloud] 复用已有 environment ${environmentId}`);
  } else {
    log('[cloud] 创建云端 environment...');
    const env = await call(pat, 'POST', '/environments', {
      name: RESOURCE_NAME,
      description: 'Stage-2 naming polish for openapi-qoder generated files',
      config: { type: 'cloud' },
    });
    environmentId = env.id as string;
  }

  let agentId = await findByName(pat, '/agents', RESOURCE_NAME);
  if (agentId) {
    log(`[cloud] 复用已有 agent ${agentId}`);
  } else {
    const model = await pickModel(pat);
    log(
      `[cloud] 创建云端 agent，模型: ${typeof model === 'string' ? model : `${model.id} (effort=${model.effort})`}`,
    );
    const agent = await call(pat, 'POST', '/agents', {
      name: RESOURCE_NAME,
      model,
      description: 'Renames and comments-only polish of generated TypeScript API files',
      system: `You polish auto-generated TypeScript API files. You have no tools and no
filesystem: everything you need is in the user message, and your reply is written
to disk verbatim.

${POLISH_RULES}`,
    });
    agentId = agent.id as string;
  }

  const ids: CloudIds = { agentId, environmentId };
  await store.set(ids);
  log(`[cloud] 使用 ${ids.agentId} / ${ids.environmentId}`);
  return ids;
}

export interface CloudTurnRequest {
  pat: string;
  ids: CloudIds;
  text: string;
  signal?: AbortSignal;
  log: Log;
  timeoutMs?: number;
}

/** Run one user message through a fresh session and return the agent's text. */
export async function runCloudTurn(req: CloudTurnRequest): Promise<string> {
  const session = await call(req.pat, 'POST', '/sessions', {
    agent: req.ids.agentId,
    environment_id: req.ids.environmentId,
    title: 'openapi-qoder Stage-2 polish',
  });
  const sessionId: string = session.id;
  req.log(`[cloud] session ${sessionId}`);

  // One controller for the SSE read: the hard timeout, the caller's cancel and a
  // clean end-of-turn all tear the stream down through the same path.
  const streamAbort = new AbortController();
  const timer = setTimeout(() => streamAbort.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onCancel = () => streamAbort.abort();
  req.signal?.addEventListener('abort', onCancel, { once: true });

  try {
    // Subscribe before sending so a fast turn cannot finish unobserved.
    const stream = await fetch(`${API_BASE}/sessions/${sessionId}/events/stream`, {
      headers: { Authorization: `Bearer ${req.pat}`, Accept: 'text/event-stream' },
      signal: streamAbort.signal,
    });
    if (!stream.ok) throw await apiError(stream, 'SSE 订阅');
    if (!stream.body) throw new Error('SSE 响应没有 body');

    await call(req.pat, 'POST', `/sessions/${sessionId}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: req.text }] }],
    });

    return await readTurn(stream.body, req.log, req.signal);
  } catch (err) {
    if (req.signal?.aborted) throw new Error('已取消');
    if (streamAbort.signal.aborted) throw new Error('云端响应超时');
    throw err;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onCancel);
    streamAbort.abort();
    // Best effort: stop any work still running and keep the console tidy.
    await call(req.pat, 'POST', `/sessions/${sessionId}/cancel`).catch(() => {});
    await call(req.pat, 'POST', `/sessions/${sessionId}/archive`).catch(() => {});
  }
}

// Reads the SSE stream until the session goes idle, accumulating `agent.message`
// text. Reconnects can replay buffered events, so events are deduped by id.
async function readTurn(
  body: ReadableStream<Uint8Array>,
  log: Log,
  signal?: AbortSignal,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const seen = new Set<string>();
  const chunks: string[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith('data:')) continue; // `id:`/`event:`/`: heartbeat`
      let event: any;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }

      if (event.type === 'agent.message') {
        if (event.id && seen.has(event.id)) continue;
        if (event.id) seen.add(event.id);
        const text = (event.content ?? [])
          .filter((b: any) => b?.type === 'text')
          .map((b: any) => b.text as string)
          .join('');
        if (text) {
          chunks.push(text);
          log(`[ai] ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
        }
      } else if (event.type === 'agent.tool_use') {
        log(`[cloud] agent 请求工具 ${event.name ?? '?'}（本 agent 未配置工具，将被忽略）`);
      } else if (event.type === 'session.status_idle') {
        const stop = event.stop_reason?.type ?? 'end_turn';
        log(`[cloud] 本轮结束 (${stop})`);
        await reader.cancel().catch(() => {});
        if (signal?.aborted) throw new Error('已取消');
        if (chunks.length === 0) throw new Error(`云端没有返回任何内容 (${stop})`);
        return chunks.join('');
      }
    }
  }

  if (chunks.length === 0) throw new Error('SSE 流提前结束且没有内容');
  return chunks.join('');
}

/**
 * Pull `### FILE: name` + fenced block sections out of the reply. Scanned line by
 * line rather than by regex so a fence inside a file body cannot swallow the rest
 * of the answer, and unknown names are dropped instead of written to disk.
 */
export function parsePolishReply(
  reply: string,
  targets: CloudPolishTarget[],
  log: Log,
): Map<string, string> {
  const known = new Map(targets.map((t) => [t.name, t]));
  const out = new Map<string, string>();

  let current: string | null = null;
  let inFence = false;
  let lines: string[] = [];

  for (const line of reply.split('\n')) {
    const header = /^#{1,6}\s*FILE:\s*(\S+)\s*$/.exec(line.trim());
    if (header && !inFence) {
      current = header[1]!;
      continue;
    }

    if (!current) continue;

    if (!inFence) {
      if (line.trimStart().startsWith('```')) {
        inFence = true;
        lines = [];
      }
      continue;
    }

    if (line.trimStart().startsWith('```')) {
      inFence = false;
      const name = current;
      current = null;
      if (!known.has(name)) {
        log(`[warn] 忽略未知文件名 ${name}`);
        continue;
      }
      out.set(name, `${lines.join('\n').replace(/\s*$/, '')}\n`);
      continue;
    }

    lines.push(line);
  }

  if (inFence) log('[warn] 回复中有未闭合的代码块，已丢弃该文件');
  return out;
}

export interface PolishSummary {
  /** `旧名 → 新名` pairs across interfaces, type aliases and request functions. */
  renames: { from: string; to: string }[];
  /** How many `unknown[]` fields got a concrete element type. */
  unknownResolved: number;
  /** Changed lines that are neither a rename nor an `unknown[]` fix — comments, mostly. */
  otherLines: number;
}

// Stage-2 may not add, remove or reorder declarations, so pairing Stage-1 with the
// polished file by declaration index is what turns a text diff into "these names
// changed".
export function summarizePolish(stage1: string, polished: string): PolishSummary {
  const a = parseFile(stage1);
  const b = parseFile(polished);

  const renames: { from: string; to: string }[] = [];
  const pair = (from: string, to: string) => {
    if (from !== to) renames.push({ from, to });
  };
  a.interfaces.forEach((x, i) => pair(x.name, b.interfaces[i]?.name ?? x.name));
  a.aliases.forEach((x, i) => pair(x.name, b.aliases[i]?.name ?? x.name));
  a.fnNames.forEach((x, i) => pair(x, b.fnNames[i] ?? x));

  const countUnknown = (s: string) => (s.match(/unknown\[\]/g) ?? []).length;
  const unknownResolved = Math.max(0, countUnknown(stage1) - countUnknown(polished));

  // Line-level churn, ignoring the lines already explained by a rename.
  const renamedNames = new Set(renames.map((r) => r.from));
  const beforeLines = stage1.split(/\r?\n/);
  const afterLines = polished.split(/\r?\n/);
  let otherLines = 0;
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
    const before = beforeLines[i] ?? '';
    const after = afterLines[i] ?? '';
    if (before === after) continue;
    if ([...renamedNames].some((n) => before.includes(n))) continue;
    if (before.includes('unknown[]')) continue;
    otherLines++;
  }

  return { renames, unknownResolved, otherLines };
}

export function formatPolishSummary(name: string, s: PolishSummary): string {
  const parts: string[] = [];
  if (s.renames.length > 0) {
    const shown = s.renames.slice(0, 3).map((r) => `${r.from}→${r.to}`).join(', ');
    parts.push(
      `${s.renames.length} 处重命名 (${shown}${s.renames.length > 3 ? ', ...' : ''})`,
    );
  }
  if (s.unknownResolved > 0) parts.push(`${s.unknownResolved} 处 unknown[] 定型`);
  if (s.otherLines > 0) parts.push(`${s.otherLines} 行注释/其他`);
  return `[polish] ${name}: ${parts.length > 0 ? parts.join('，') : '无实质变化'}`;
}

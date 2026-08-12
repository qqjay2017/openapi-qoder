// openapi-qoder — unified CLI.
//
//   qgen list                       list spaces / projects
//   qgen pick                       interactive: space -> project -> generate
//   qgen gen <projectId>            fetch + Stage-1 + apply ledger
//   qgen harvest <projectId>        record Stage-2 decisions into the ledger
//   qgen status <projectId>         show what still needs AI
//
// Auth: TORNA_TOKEN (+ optional TORNA_BASE_URL).

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { generateFile } from './codegen/emit.js';
import { TornaClient, configFromEnv, type ApiTreeNode } from './torna/client.js';
import { parseHeader } from './ledger/parse.js';
import { artifactDir, repoRoot, scaffold } from './paths.js';
import {
  applyEntry,
  harvestEntry,
  loadLedger,
  pendingWork,
  saveLedger,
  type Ledger,
} from './ledger/index.js';

const root = repoRoot;
const LEDGER_FILE = join(root, '.openapi-qoder', 'naming.lock.json');

const stage1Dir = (pid: string) => artifactDir(pid);
const finalDir = (pid: string) => artifactDir(`${pid}-polished`);

async function mapLimit<T, R>(items: T[], limit: number, fn: (i: T) => Promise<R>): Promise<R[]> {
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

function slugFromUrl(url: string, fallback: string): string {
  const slug = url
    .split('/')
    .filter(Boolean)
    .filter((s) => !['2m', '2b', '2c'].includes(s.toLowerCase()))
    .filter((s) => !/^v\d/i.test(s))
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'common.ts' && !f.startsWith('_'));
}

async function cmdList(client: TornaClient): Promise<void> {
  for (const space of await client.getProjects()) {
    console.log(`\n# ${space.name} (${space.id})`);
    for (const p of space.projects) {
      console.log(`  ${p.id}  ${p.name}${p.description ? `  — ${p.description}` : ''}`);
    }
  }
}

async function cmdPick(client: TornaClient): Promise<void> {
  const spaces = await client.getProjects();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    spaces.forEach((s, i) => console.log(`  [${i + 1}] ${s.name}`));
    const si = Number(await rl.question('选择空间编号: ')) - 1;
    const space = spaces[si];
    if (!space) throw new Error('无效的空间编号');

    space.projects.forEach((p, i) => console.log(`  [${i + 1}] ${p.name}  (${p.id})`));
    const pi = Number(await rl.question('选择项目编号: ')) - 1;
    const project = space.projects[pi];
    if (!project) throw new Error('无效的项目编号');

    console.log(`\n-> ${project.name} (${project.id})\n`);
    await cmdGen(client, project.id);
  } finally {
    rl.close();
  }
}

async function cmdGen(client: TornaClient, pid: string, force = false): Promise<void> {
  const tree = await client.getApiTree(pid);
  const apis = tree.filter((n): n is ApiTreeNode & { docId: string } => n.type === 3 && !!n.docId);
  console.log(`Fetching ${apis.length} API detail(s)...`);

  const s1 = stage1Dir(pid);
  const fin = finalDir(pid);
  scaffold(s1);
  scaffold(fin);

  const ledger = loadLedger(LEDGER_FILE);
  const used = new Set<string>();
  let reused = 0;
  let needAi = 0;
  let keptPolished = 0;
  const failures: string[] = [];

  await mapLimit(apis, 5, async (api) => {
    try {
      const detail = await client.getDetail(api.docId);
      let slug = slugFromUrl(detail.url || api.url, api.docId);
      while (used.has(slug)) slug = `${slug}-${api.docId}`;
      used.add(slug);

      const code = generateFile(detail);
      writeFileSync(join(s1, `${slug}.ts`), code);

      const { shape } = parseHeader(code);
      const entry = ledger.apis[api.docId];
      const stale = !!entry && entry.shape !== shape;

      // Stage 1.5 — deterministic replay of previous AI/manual decisions.
      // A stale entry's types/fieldTypes are keyed to a structure that no longer
      // exists, so only the locked fn name survives; Stage-2 re-derives the rest.
      const replay = stale ? { ...entry!, types: {}, fieldTypes: {} } : entry;
      const applied = replay ? applyEntry(code, replay) : code;

      // Stage-2 output that has not been harvested yet is unrecoverable, so it
      // wins over a fresh Stage-1.5 replay unless the caller insists.
      const finalPath = join(fin, `${slug}.ts`);
      const polished =
        !force && existsSync(finalPath) && readFileSync(finalPath, 'utf8').includes('Stage-2');
      if (polished) keptPolished++;
      else writeFileSync(finalPath, applied);

      if (entry && !stale) reused++;
      if (!entry || stale || pendingWork(applied).unknownArrays > 0) needAi++;
    } catch (err) {
      failures.push(`${api.label} [${api.docId}]: ${(err as Error).message}`);
    }
  });

  console.log(`\nStage-1 -> generated/${pid}/  (${used.size} file(s))`);
  console.log(`Stage-1.5 -> generated/${pid}-polished/  (ledger applied to ${reused} unchanged API(s))`);
  if (keptPolished) {
    console.log(
      `  kept ${keptPolished} un-harvested Stage-2 file(s) as-is.\n` +
        `  Run \`qgen harvest ${pid}\` to record them, then \`qgen gen ${pid} --force\` to refresh.`,
    );
  }
  console.log(`${needAi} API(s) need AI polish. Run:  npx tsx src/polish-run.ts ${pid}`);
  if (failures.length) console.log(`\n${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
}

function cmdHarvest(pid: string): void {
  const s1 = stage1Dir(pid);
  const fin = finalDir(pid);
  const ledger: Ledger = loadLedger(LEDGER_FILE);
  let added = 0;
  let skippedManual = 0;
  let rejected = 0;

  for (const name of tsFiles(fin)) {
    const stage1Path = join(s1, name);
    if (!existsSync(stage1Path)) continue;
    const before = readFileSync(stage1Path, 'utf8');
    const after = readFileSync(join(fin, name), 'utf8');

    const { docId } = parseHeader(before);
    if (docId === '-') continue;
    if (ledger.apis[docId]?.source === 'manual') {
      skippedManual++;
      continue;
    }

    const meta = /^\/\/ (\S+) (\S+)/m.exec(before.split('\n')[1] ?? '');
    const entry = harvestEntry(before, after, {
      httpMethod: meta?.[1] ?? 'POST',
      url: meta?.[2] ?? '',
    });
    if (!entry) {
      rejected++;
      continue;
    }
    const hasDecisions =
      Object.keys(entry.types).length > 0 ||
      Object.keys(entry.fieldTypes).length > 0 ||
      !!entry.fn;
    if (!hasDecisions) continue;

    ledger.apis[docId] = { ...ledger.apis[docId], ...entry };
    added++;
  }

  saveLedger(LEDGER_FILE, ledger);
  console.log(`Ledger: recorded ${added} API(s) -> ${LEDGER_FILE}`);
  if (skippedManual) console.log(`  kept ${skippedManual} manual entry/entries untouched`);
  if (rejected) console.log(`  refused ${rejected} file(s) whose structure did not match Stage-1`);
}

function cmdStatus(pid: string): void {
  const ledger = loadLedger(LEDGER_FILE);
  const s1 = stage1Dir(pid);
  const fin = finalDir(pid);
  const names = tsFiles(s1);
  let inLedger = 0;
  let stale = 0;
  let unresolved = 0;
  for (const name of names) {
    const src = readFileSync(join(s1, name), 'utf8');
    const { docId, shape } = parseHeader(src);
    const entry = ledger.apis[docId];
    if (entry) {
      inLedger++;
      if (entry.shape !== shape) stale++;
    }
    const finalPath = join(fin, name);
    if (existsSync(finalPath)) {
      unresolved += pendingWork(readFileSync(finalPath, 'utf8')).unknownArrays;
    }
  }
  console.log(`project ${pid}`);
  console.log(`  APIs:              ${names.length}`);
  console.log(`  in ledger:         ${inLedger}`);
  console.log(`  shape changed:     ${stale}  (need AI re-polish)`);
  console.log(`  unresolved unknown[]: ${unresolved}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const [cmd, arg] = argv.filter((a) => !a.startsWith('--'));

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(
      'openapi-qoder\n\n' +
        '  list                 列出空间/项目\n' +
        '  pick                 交互式选择空间→项目→生成\n' +
        '  gen <projectId>      拉取 + Stage-1 + 复用账本\n' +
        '  harvest <projectId>  把 Stage-2 结果记入账本\n' +
        '  status <projectId>   查看待润色情况\n\n' +
        '  --force              gen 时覆盖尚未 harvest 的 Stage-2 文件',
    );
    return;
  }

  if (cmd === 'harvest' || cmd === 'status') {
    if (!arg) throw new Error(`${cmd} 需要 projectId`);
    if (cmd === 'harvest') cmdHarvest(arg);
    else cmdStatus(arg);
    return;
  }

  const client = new TornaClient(configFromEnv());
  if (cmd === 'list') await cmdList(client);
  else if (cmd === 'pick') await cmdPick(client);
  else if (cmd === 'gen') {
    if (!arg) throw new Error('gen 需要 projectId');
    await cmdGen(client, arg, force);
  } else throw new Error(`未知命令: ${cmd}`);
}

main().catch((err) => {
  console.error(`\nError: ${(err as Error).message}`);
  process.exitCode = 1;
});

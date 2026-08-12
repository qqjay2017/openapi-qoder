// openapi-qoder — unified CLI.
//
//   qgen list                       list spaces / projects
//   qgen pick                       interactive: space -> project -> generate
//   qgen gen <projectId|docId>      fetch + Stage-1 + apply ledger
//   qgen gen-folder <docId>         merge every API of that doc's folder into one file
//   qgen harvest <projectId>        record Stage-2 decisions into the ledger
//   qgen status <projectId>         show what still needs AI
//
// Auth: TORNA_TOKEN (+ optional TORNA_BASE_URL).

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { generateFile, generateFolderFile } from './codegen/emit.js';
import { TornaClient, configFromEnv, type ApiTreeNode } from './torna/client.js';
import { parseHeader } from './ledger/parse.js';
import { artifactDir, repoRoot, scaffold } from './paths.js';
import { commonSlug, findFolder, mapLimit, slugFromUrl } from './core/index.js';
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

interface GenTarget {
  docId: string;
  label: string;
  url: string;
}

// A projectId and a docId are both 8-char opaque ids, so the only way to tell
// them apart is to ask. Try the project tree first; if that is not a project,
// treat the id as a single API doc.
async function resolveTargets(client: TornaClient, id: string): Promise<GenTarget[]> {
  try {
    const tree = await client.getApiTree(id);
    const leaves = tree.filter((n): n is ApiTreeNode & { docId: string } => n.type === 3 && !!n.docId);
    if (leaves.length > 0) {
      console.log(`${id} is a project: ${leaves.length} API(s).`);
      return leaves.map((n) => ({ docId: n.docId, label: n.label, url: n.url }));
    }
  } catch {
    // Not a projectId — fall through to the single-doc path.
  }
  if (loadLedger(LEDGER_FILE).apis[id]?.kind === 'folder') {
    throw new Error(`${id} 是一个目录，请用:  qgen gen-folder <该目录下任一接口的 docId>`);
  }
  console.log(`${id} is a single API doc.`);
  return [{ docId: id, label: id, url: '' }];
}

async function cmdGen(client: TornaClient, id: string, force = false): Promise<void> {
  const apis = await resolveTargets(client, id);
  console.log(`Fetching ${apis.length} API detail(s)...`);

  const s1 = stage1Dir(id);
  const fin = finalDir(id);
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

  console.log(`\nStage-1 -> generated/${id}/  (${used.size} file(s))`);
  console.log(`Stage-1.5 -> generated/${id}-polished/  (ledger applied to ${reused} unchanged API(s))`);
  if (keptPolished) {
    console.log(
      `  kept ${keptPolished} un-harvested Stage-2 file(s) as-is.\n` +
        `  Run \`qgen harvest ${id}\` to record them, then \`qgen gen ${id} --force\` to refresh.`,
    );
  }
  console.log(`${needAi} API(s) need AI polish. Run:  npx tsx src/polish-run.ts ${id}`);
  if (failures.length) console.log(`\n${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
}

async function cmdGenFolder(client: TornaClient, docId: string, force = false): Promise<void> {
  const seed = await client.getDetail(docId);
  if (!seed.projectId) throw new Error(`${docId} 的 detail 没有 projectId，无法定位目录`);
  const tree = await client.getApiTree(seed.projectId);
  const folder = findFolder(tree, docId, seed.parentId);
  if (!folder) throw new Error(`找不到 ${docId} 所在的目录（parentId=${seed.parentId}）`);

  const siblings = tree.filter((n): n is ApiTreeNode & { docId: string } =>
    n.parentId === folder.id && n.type === 3 && !!n.docId,
  );
  if (siblings.length === 0) throw new Error(`目录 ${folder.label} 下没有接口`);
  console.log(`目录 ${folder.label} (${folder.docId})：${siblings.length} 个接口`);

  const details = (
    await mapLimit(siblings, 5, async (api) => {
      try {
        return await client.getDetail(api.docId);
      } catch (err) {
        console.log(`  ! ${api.label} [${api.docId}]: ${(err as Error).message}`);
        return null;
      }
    })
  ).filter((d): d is Awaited<ReturnType<typeof client.getDetail>> => d !== null);
  if (details.length === 0) throw new Error('所有接口详情都拉取失败');

  const s1 = stage1Dir(folder.docId);
  const fin = finalDir(folder.docId);
  scaffold(s1);
  scaffold(fin);

  const code = generateFolderFile(details, { docId: folder.docId, label: folder.label });
  const slug = commonSlug(details.map((d) => d.url), folder.docId);
  writeFileSync(join(s1, `${slug}.ts`), code);

  const { shape } = parseHeader(code);
  const entry = loadLedger(LEDGER_FILE).apis[folder.docId];
  const stale = !!entry && entry.shape !== shape;
  const replay = stale ? { ...entry!, types: {}, fieldTypes: {} } : entry;
  const applied = replay ? applyEntry(code, replay) : code;

  const finalPath = join(fin, `${slug}.ts`);
  const keep =
    !force && existsSync(finalPath) && readFileSync(finalPath, 'utf8').includes('Stage-2');
  if (!keep) writeFileSync(finalPath, applied);

  console.log(`\nStage-1 -> generated/${folder.docId}/${slug}.ts  (${details.length} API(s))`);
  if (keep) {
    console.log(
      `  kept the un-harvested Stage-2 file as-is.\n` +
        `  Run \`qgen harvest ${folder.docId}\`, then \`qgen gen-folder ${docId} --force\`.`,
    );
  } else if (entry && !stale) {
    console.log(`Stage-1.5 -> ledger replayed (shape unchanged)`);
  }
  console.log(`${pendingWork(applied).unknownArrays} unresolved unknown[].`);
  console.log(`Polish:  npx tsx src/polish-run.ts ${folder.docId}`);
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
      Object.keys(entry.fns).length > 0;
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
        '  gen <projectId|docId>  拉取 + Stage-1 + 复用账本（单个接口传 docId）\n' +
        '  gen-folder <docId>   把该接口所在目录的全部接口合并生成到一个文件\n' +
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
  } else if (cmd === 'gen-folder') {
    if (!arg) throw new Error('gen-folder 需要该目录下任一接口的 docId');
    await cmdGenFolder(client, arg, force);
  } else throw new Error(`未知命令: ${cmd}`);
}

main().catch((err) => {
  console.error(`\nError: ${(err as Error).message}`);
  process.exitCode = 1;
});

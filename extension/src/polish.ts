// Stage E: AI polish via local qodercli + in-process tsc gate.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as ts from 'typescript';
import { buildPolishPrompt, type PolishTarget } from '../../src/polish/prompt.js';
import { harvestEntry, loadLedger, saveLedger, type ApiLedgerEntry } from '../../src/ledger/index.js';
import { parseFile, parseHeader } from '../../src/ledger/parse.js';

export interface PolishRequest {
  files: string[];
  workspaceRoot: string;
  signal?: AbortSignal;
  onProgress: (msg: string) => void;
  onLog: (msg: string) => void;
}

export interface PolishResult {
  polished: number;
  reverted: number;
}

function readApis(filePath: string): { httpMethod: string; url: string; docName: string }[] {
  const apis: { httpMethod: string; url: string; docName: string }[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const m = /^\/\/ ([A-Z]+) (\/\S*)\s*(.*)$/.exec(line);
    if (m) apis.push({ httpMethod: m[1]!, url: m[2]!, docName: m[3]!.trim() });
  }
  return apis.length > 0
    ? apis
    : [{ httpMethod: 'POST', url: '', docName: path.basename(filePath, '.ts') }];
}

// Diagnostics about unresolved imports are expected: the generated files import
// the host project's request client and pagination type, which are outside the
// checked file set. The gate is here to catch what the AI can break — duplicate
// identifiers and dangling references after a rename.
const IGNORED_DIAGNOSTICS = new Set([
  2307, // Cannot find module
  2792, // Cannot find module, consider moduleResolution
  2686, // refers to a UMD global
]);

function typeCheck(files: string[], outputDir: string): { ok: boolean; brokenFiles: Set<string> } {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: outputDir,
  };

  const program = ts.createProgram(files, compilerOptions);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => !IGNORED_DIAGNOSTICS.has(d.code));

  const brokenFiles = new Set<string>();
  for (const d of diagnostics) {
    if (d.file) brokenFiles.add(path.basename(d.file.fileName));
  }
  return { ok: diagnostics.length === 0, brokenFiles };
}

function getQodercliPath(): string {
  return vscode.workspace.getConfiguration('openapiQoder').get<string>('qodercliPath') ?? 'qodercli';
}

interface RunOptions {
  prompt: string;
  cwd: string;
  maxTurns: number;
  signal?: AbortSignal;
  onLog: (msg: string) => void;
}

async function runQodercli(opts: RunOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) { resolve(false); return; }

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--permission-mode', 'accept_edits',
      '--allowed-tools', 'Read,Edit',
      '--max-turns', String(opts.maxTurns),
      '--no-session-persistence',
      '--setting-sources', '',
    ];

    const proc = spawn(getQodercliPath(), args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // Kill child process when abort fires.
    const onAbort = () => {
      opts.onLog('[qodercli] 收到取消信号，终止进程');
      proc.kill('SIGTERM');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdin.write(opts.prompt);
    proc.stdin.end();

    let lastResult: any = null;
    let buffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'assistant') {
            const text = (msg.message?.content?.[0]?.text ?? '').slice(0, 80);
            if (text) opts.onLog(`[ai] ${text}`);
          } else if (msg.type === 'tool_use') {
            opts.onLog(`[tool] ${msg.name ?? 'unknown'} ${(msg.input?.file_path ?? msg.input?.command ?? '').slice(0, 60)}`);
          } else if (msg.type === 'result') {
            lastResult = msg;
          }
        } catch { /* non-JSON line, ignore */ }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) opts.onLog(`[stderr] ${text.slice(0, 120)}`);
    });

    proc.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) { resolve(false); return; }
      if (code !== 0) { opts.onLog(`[qodercli] 退出码 ${code}`); resolve(false); return; }
      const success = lastResult?.subtype === 'success';
      opts.onLog(`[qodercli] 完成: ${success ? '成功' : '失败'}`);
      resolve(success);
    });

    proc.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      opts.onLog(`[qodercli] 启动失败: ${err.message}`);
      resolve(false);
    });
  });
}

export async function polishFiles(req: PolishRequest): Promise<PolishResult> {
  const outputDir = path.dirname(req.files[0]!);
  const ledgerPath = path.join(req.workspaceRoot, '.openapi-qoder', 'naming.lock.json');

  // Snapshot before polish so we can roll back broken files.
  const snapshots = new Map<string, string>();
  const targets: PolishTarget[] = [];

  for (const file of req.files) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('Stage-2')) {
      req.onLog(`[skip] ${path.basename(file)} 已有 Stage-2 标记`);
      continue;
    }
    snapshots.set(file, content);
    targets.push({ file, apis: readApis(file) });
  }

  if (targets.length === 0) {
    req.onLog('[polish] 没有需要润色的文件');
    return { polished: 0, reverted: 0 };
  }

  const apiCount = targets.reduce((sum, t) => sum + t.apis.length, 0);
  const maxTurns = Math.max(40, apiCount * 6);

  req.onProgress(`AI 润色 ${targets.length} 个文件 (${apiCount} 个接口, maxTurns=${maxTurns})...`);
  req.onLog(`[polish] 文件: ${targets.map(t => path.basename(t.file)).join(', ')}`);
  req.onLog(`[polish] 接口: ${targets.flatMap(t => t.apis.map(a => a.url)).join(', ')}`);

  if (req.signal?.aborted) throw new Error('已取消');

  const prompt = buildPolishPrompt(targets);
  req.onLog(`[polish] prompt 长度: ${prompt.length} 字符`);

  const ok = await runQodercli({
    prompt,
    cwd: req.workspaceRoot,
    maxTurns,
    signal: req.signal,
    onLog: req.onLog,
  });

  if (req.signal?.aborted) throw new Error('已取消');

  if (!ok) {
    req.onProgress('qodercli 运行失败，回滚全部文件');
    for (const [file, content] of snapshots) fs.writeFileSync(file, content);
    return { polished: 0, reverted: snapshots.size };
  }

  // Type-check the polished output.
  req.onLog('[tsc] 检查编译...');
  const allTs = fs.readdirSync(outputDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(outputDir, f));
  const { ok: compiles, brokenFiles } = typeCheck(allTs, outputDir);

  let reverted = 0;
  if (!compiles) {
    for (const [file, content] of snapshots) {
      if (brokenFiles.has(path.basename(file))) {
        fs.writeFileSync(file, content);
        reverted++;
        req.onProgress(`↺ 回滚 ${path.basename(file)} (编译失败)`);
        req.onLog(`[tsc] 回滚 ${path.basename(file)}`);
      }
    }
  } else {
    req.onLog('[tsc] 编译通过');
  }

  // Mark surviving polished files with the Stage-2 banner.
  let polished = 0;
  for (const [file] of snapshots) {
    if (brokenFiles.has(path.basename(file))) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('Stage-2')) {
      const next = src.replace(
        /^\/\/ AUTO-GENERATED by openapi-qoder Stage-1\. Do not edit by hand\.$/m,
        '// AUTO-GENERATED by openapi-qoder (Stage-1 codegen + Stage-2 AI polish).\n' +
          '// Names are pinned in .openapi-qoder/naming.lock.json — edit there, not here.',
      );
      if (next !== src) fs.writeFileSync(file, next);
    }
    polished++;
  }

  // Harvest decisions into the ledger.
  if (polished > 0) {
    req.onProgress('记录命名决策到账本...');
    const ledger = loadLedger(ledgerPath);
    for (const [file, stage1] of snapshots) {
      if (brokenFiles.has(path.basename(file))) continue;
      const after = fs.readFileSync(file, 'utf8');
      const { docId } = parseHeader(stage1);
      if (docId === '-') continue;
      if (ledger.apis[docId]?.source === 'manual') continue;

      const meta = /^\/\/ (\S+) (\S+)/m.exec(stage1.split('\n')[1] ?? '');
      const entry = harvestEntry(stage1, after, {
        httpMethod: meta?.[1] ?? 'POST',
        url: meta?.[2] ?? '',
      });
      if (entry) {
        const hasDecisions =
          Object.keys(entry.types).length > 0 ||
          Object.keys(entry.fieldTypes).length > 0 ||
          Object.keys(entry.fns).length > 0;
        if (hasDecisions) ledger.apis[docId] = { ...ledger.apis[docId], ...entry };
      }
    }
    saveLedger(ledgerPath, ledger);
    req.onLog(`[polish] 账本已更新`);
  }

  return { polished, reverted };
}

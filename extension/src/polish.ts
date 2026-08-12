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
  onProgress: (msg: string) => void;
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

function typeCheck(files: string[], outputDir: string): { ok: boolean; brokenFiles: Set<string> } {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: outputDir,
    paths: { '@/utils/request': ['./_request-stub.ts'] },
  };

  const program = ts.createProgram(files, compilerOptions);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const brokenFiles = new Set<string>();
  for (const d of diagnostics) {
    if (d.file) brokenFiles.add(path.basename(d.file.fileName));
  }
  return { ok: diagnostics.length === 0, brokenFiles };
}

function getQodercliPath(): string {
  return vscode.workspace.getConfiguration('openapiQoder').get<string>('qodercliPath') ?? 'qodercli';
}

async function runQodercli(prompt: string, cwd: string, maxTurns: number): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--permission-mode', 'accept_edits',
      '--allowed-tools', 'Read,Edit',
      '--max-turns', String(maxTurns),
      '--no-session-persistence',
      '--setting-sources', '',
    ];

    const proc = spawn(getQodercliPath(), args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', () => {});

    proc.on('close', (code) => {
      if (code !== 0) { resolve(false); return; }
      try {
        const result = JSON.parse(stdout);
        resolve(result.subtype === 'success');
      } catch {
        resolve(false);
      }
    });

    proc.on('error', () => resolve(false));
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
    if (content.includes('Stage-2')) continue;
    snapshots.set(file, content);
    targets.push({ file, apis: readApis(file) });
  }

  if (targets.length === 0) return { polished: 0, reverted: 0 };

  const apiCount = targets.reduce((sum, t) => sum + t.apis.length, 0);
  const maxTurns = Math.max(40, apiCount * 6);

  req.onProgress(`AI 润色 ${targets.length} 个文件 (${apiCount} 个接口, maxTurns=${maxTurns})...`);

  const prompt = buildPolishPrompt(targets);
  const ok = await runQodercli(prompt, req.workspaceRoot, maxTurns);

  if (!ok) {
    req.onProgress('qodercli 运行失败，回滚全部文件');
    for (const [file, content] of snapshots) fs.writeFileSync(file, content);
    return { polished: 0, reverted: snapshots.size };
  }

  // Type-check the polished output.
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
      }
    }
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
  }

  return { polished, reverted };
}

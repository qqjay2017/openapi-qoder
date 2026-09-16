// Stage D: generate files and write them into the workspace via WorkspaceEdit.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { generateFile, generateFolderFile, type TornaDetail, type GenerateOptions as EmitOptions } from '../../src/codegen/emit.js';
import { TornaClient } from '../../src/torna/client.js';
import { mapLimit, commonSlug, findFolder } from '../../src/core/index.js';
import { loadLedger, applyEntry, pendingWork, saveLedger } from '../../src/ledger/index.js';
import { parseHeader } from '../../src/ledger/parse.js';
import { polishFiles, type PolishFileReport, type PolishRequest } from './polish';
import type { GenerateOptions, TreeNodeMsg } from './shared/protocol';

export interface GenerateRequest {
  selectedIds: string[];
  tree: TreeNodeMsg[];
  options: GenerateOptions;
  token: string;
  baseUrl: string;
  projectId: string;
  /** Required when `options.aiPolish` is set. */
  cloud?: PolishRequest['cloud'];
  signal?: AbortSignal;
  onProgress: (msg: string) => void;
  onLog: (msg: string) => void;
}

export interface GenerateResult {
  files: string[];
  polish?: PolishFileReport[];
}

interface FolderGroup {
  folderId: string;
  folderDocId: string;
  folderLabel: string;
  apiNodes: TreeNodeMsg[];
}

function groupByFolder(selectedIds: Set<string>, tree: TreeNodeMsg[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();

  function walk(nodes: TreeNodeMsg[], parentFolder: { id: string; docId: string; label: string } | null) {
    for (const node of nodes) {
      if (node.type === 2) {
        walk(node.children, { id: node.id, docId: node.docId ?? node.id, label: node.label });
      } else if (node.type === 3 && node.docId && selectedIds.has(node.id)) {
        const folder = parentFolder ?? { id: '__root__', docId: '__root__', label: 'root' };
        let group = groups.get(folder.id);
        if (!group) {
          group = { folderId: folder.id, folderDocId: folder.docId, folderLabel: folder.label, apiNodes: [] };
          groups.set(folder.id, group);
        }
        group.apiNodes.push(node);
      } else if (node.children.length) {
        walk(node.children, parentFolder);
      }
    }
  }

  walk(tree, null);
  return [...groups.values()];
}

export async function generateAndWrite(req: GenerateRequest): Promise<GenerateResult> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) throw new Error('没有打开的工作区');

  const cfg = vscode.workspace.getConfiguration('openapiQoder');
  const outputDir = cfg.get<string>('outputDir') ?? 'src/api';
  const outPath = path.join(wsFolder.uri.fsPath, outputDir);
  const ledgerPath = path.join(wsFolder.uri.fsPath, '.openapi-qoder', 'naming.lock.json');

  const client = new TornaClient({ baseUrl: req.baseUrl, token: req.token });
  const selectedSet = new Set(req.selectedIds);
  const groups = groupByFolder(selectedSet, req.tree);

  if (groups.length === 0) throw new Error('没有选中任何接口');

  const emitOpts: EmitOptions = {
    requestModule: cfg.get<string>('requestModule') ?? '@/utils/request',
    pageResultModule: cfg.get<string>('pageResultModule') ?? '@/utils/request',
    requestFns: req.options.requestFns,
    enums: req.options.enums,
    options: req.options.options,
  };

  const ledger = loadLedger(ledgerPath);
  const writtenFiles: string[] = [];
  const stage1Sources: Record<string, string> = {};
  const edit = new vscode.WorkspaceEdit();

  req.onProgress(`正在生成 ${groups.length} 个目录...`);

  for (const group of groups) {
    if (req.signal?.aborted) throw new Error('已取消');

    req.onProgress(`拉取 ${group.folderLabel} (${group.apiNodes.length} 个接口)...`);
    req.onLog(`[fetch] 目录: ${group.folderLabel}, ${group.apiNodes.length} 个接口`);

    let fetched = 0;
    let failed = 0;
    const details = (
      await mapLimit(group.apiNodes, 5, async (api) => {
        if (req.signal?.aborted) return null;
        try {
          const d = await client.getDetail(api.docId!);
          fetched++;
          req.onLog(`  ✓ ${api.docId} ${(d as any).url ?? ''}`);
          return d;
        } catch (err) {
          failed++;
          req.onLog(`  ✗ ${api.docId}: ${(err as Error).message}`);
          return null;
        }
      })
    ).filter((d): d is TornaDetail => d !== null);

    req.onLog(`[fetch] 完成: ${fetched} 成功, ${failed} 失败`);

    if (details.length === 0) {
      req.onLog(`[skip] 目录 ${group.folderLabel} 无有效接口, 跳过`);
      continue;
    }

    let code: string;
    let slug: string;

    if (details.length === 1) {
      code = generateFile(details[0]!, emitOpts);
      slug = commonSlug([details[0]!.url], details[0]!.id ?? 'api');
    } else {
      code = generateFolderFile(details, { docId: group.folderDocId, label: group.folderLabel }, emitOpts);
      slug = commonSlug(details.map((d) => d.url), group.folderDocId);
    }

    const fileName = `${slug}.ts`;
    const filePath = path.join(outPath, fileName);
    const fileUri = vscode.Uri.file(filePath);

    // Stage-1.5: apply the exact cached polish when possible. An unrecorded
    // Stage-2 file is preserved so a failed harvest never destroys user work.
    const { docId: entryKey, shape } = parseHeader(code);
    const entry = ledger.apis[entryKey];
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing.includes('Stage-2') && !entry) {
        req.onProgress(`跳过 ${fileName}（润色结果尚未入账）`);
        continue;
      }
    }
    const stale = !!entry && entry.shape !== shape;
    const replay = stale ? { ...entry!, types: {}, fieldTypes: {} } : entry;
    const applied = replay ? applyEntry(code, replay, wsFolder.uri.fsPath) : code;

    edit.createFile(fileUri, { overwrite: true, ignoreIfExists: false });
    edit.replace(fileUri, new vscode.Range(0, 0, 100000, 0), applied);
    stage1Sources[fileName] = code;
    writtenFiles.push(fileName);
  }

  req.onProgress('写入文件...');
  const editApplied = await vscode.workspace.applyEdit(edit);
  if (!editApplied) throw new Error('WorkspaceEdit 写入失败');

  // applyEdit only touches in-memory buffers. They must be flushed before Stage-2,
  // which reads and writes the files on disk: a dirty buffer would both hide the
  // polished result and overwrite it on the next manual save.
  const writtenPaths = new Set(writtenFiles.map((f) => path.join(outPath, f)));
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty || !writtenPaths.has(doc.uri.fsPath)) continue;
    if (!(await doc.save())) req.onLog(`[warn] ${path.basename(doc.uri.fsPath)} 保存失败`);
  }

  // Save ledger (in case stale entries were cleared).
  saveLedger(ledgerPath, ledger);

  // Stage-2: AI polish if requested.
  let polish: PolishFileReport[] | undefined;
  if (req.options.aiPolish && writtenFiles.length > 0) {
    if (req.signal?.aborted) throw new Error('已取消');
    if (!req.cloud) throw new Error('AI 润色需要 Qoder 个人访问令牌');
    req.onProgress('启动 AI 润色...');
    const filePaths = writtenFiles.map((f) => path.join(outPath, f));
    const result = await polishFiles({
      files: filePaths,
      stage1Sources,
      workspaceRoot: wsFolder.uri.fsPath,
      cloud: req.cloud,
      signal: req.signal,
      onProgress: req.onProgress,
      onLog: req.onLog,
    });
    if (req.signal?.aborted) throw new Error('已取消');
    polish = result.report;
    req.onProgress(
      `润色完成: ${result.polished} 个文件通过` +
        (result.reverted > 0 ? `, ${result.reverted} 个回滚` : ''),
    );
  }

  return { files: writtenFiles, polish };
}

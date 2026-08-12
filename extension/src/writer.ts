// Stage D: generate files and write them into the workspace via WorkspaceEdit.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { generateFile, generateFolderFile, type TornaDetail, type GenerateOptions as EmitOptions } from '../../src/codegen/emit.js';
import { TornaClient } from '../../src/torna/client.js';
import { mapLimit, commonSlug, findFolder } from '../../src/core/index.js';
import { loadLedger, applyEntry, pendingWork, saveLedger } from '../../src/ledger/index.js';
import { parseHeader } from '../../src/ledger/parse.js';
import { COMMON_TS, REQUEST_STUB_TS } from '../../src/shared/assets.js';
import { polishFiles } from './polish';
import type { GenerateOptions, TreeNodeMsg } from './shared/protocol';

export interface GenerateRequest {
  selectedIds: string[];
  tree: TreeNodeMsg[];
  options: GenerateOptions;
  token: string;
  baseUrl: string;
  projectId: string;
  signal?: AbortSignal;
  onProgress: (msg: string) => void;
  onLog: (msg: string) => void;
}

export interface GenerateResult {
  files: string[];
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

  const outputDir = vscode.workspace.getConfiguration('openapiQoder').get<string>('outputDir') ?? 'src/api';
  const outPath = path.join(wsFolder.uri.fsPath, outputDir);
  const ledgerPath = path.join(wsFolder.uri.fsPath, '.openapi-qoder', 'naming.lock.json');

  const client = new TornaClient({ baseUrl: req.baseUrl, token: req.token });
  const selectedSet = new Set(req.selectedIds);
  const groups = groupByFolder(selectedSet, req.tree);

  if (groups.length === 0) throw new Error('没有选中任何接口');

  const emitOpts: EmitOptions = {
    requestFns: req.options.requestFns,
    enums: req.options.enums,
    options: req.options.options,
  };

  const ledger = loadLedger(ledgerPath);
  const writtenFiles: string[] = [];
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

    // Do not overwrite files already polished by Stage-2.
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing.includes('Stage-2')) {
        req.onProgress(`跳过 ${fileName}（已润色，请先 harvest）`);
        continue;
      }
    }

    // Stage-1.5: apply ledger if shape matches.
    const { docId: entryKey, shape } = parseHeader(code);
    const entry = ledger.apis[entryKey];
    const stale = !!entry && entry.shape !== shape;
    const replay = stale ? { ...entry!, types: {}, fieldTypes: {} } : entry;
    const applied = replay ? applyEntry(code, replay) : code;

    edit.createFile(fileUri, { overwrite: true, ignoreIfExists: false });
    edit.replace(fileUri, new vscode.Range(0, 0, 100000, 0), applied);
    writtenFiles.push(fileName);
  }

  // Write infrastructure files (emit.ts generates imports that reference them).
  const commonUri = vscode.Uri.file(path.join(outPath, 'common.ts'));
  edit.createFile(commonUri, { overwrite: true, ignoreIfExists: false });
  edit.replace(commonUri, new vscode.Range(0, 0, 100000, 0), COMMON_TS);

  const stubUri = vscode.Uri.file(path.join(outPath, '_request-stub.ts'));
  edit.createFile(stubUri, { overwrite: true, ignoreIfExists: false });
  edit.replace(stubUri, new vscode.Range(0, 0, 100000, 0), REQUEST_STUB_TS);

  req.onProgress('写入文件...');
  const editApplied = await vscode.workspace.applyEdit(edit);
  if (!editApplied) throw new Error('WorkspaceEdit 写入失败');

  // Save ledger (in case stale entries were cleared).
  saveLedger(ledgerPath, ledger);

  // Stage-2: AI polish if requested.
  if (req.options.aiPolish && writtenFiles.length > 0) {
    req.onProgress('启动 AI 润色...');
    const filePaths = writtenFiles.map((f) => path.join(outPath, f));
    const result = await polishFiles({
      files: filePaths,
      workspaceRoot: wsFolder.uri.fsPath,
      onProgress: req.onProgress,
    });
    req.onProgress(
      `润色完成: ${result.polished} 个文件通过` +
        (result.reverted > 0 ? `, ${result.reverted} 个回滚` : ''),
    );
  }

  return { files: writtenFiles };
}

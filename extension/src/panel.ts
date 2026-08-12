import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ToExtension, ToWebview, TreeNodeMsg } from './shared/protocol';
import { generateAndWrite } from './writer';

let currentPanel: vscode.WebviewPanel | undefined;

// Cached from the last successful loadTree call.
let lastTree: TreeNodeMsg[] = [];
let lastBaseUrl = '';
let lastProjectId = '';
let lastToken = '';

let generateAbort: AbortController | undefined;
let outputChannel: vscode.OutputChannel | undefined;

function getOutput(): vscode.OutputChannel {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel('OpenAPI Qoder');
  return outputChannel;
}

export function createPanel(context: vscode.ExtensionContext) {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }

  const distWebview = path.join(context.extensionPath, 'dist', 'webview');

  currentPanel = vscode.window.createWebviewPanel(
    'openapiQoder',
    'OpenAPI Qoder',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(distWebview)],
    },
  );

  currentPanel.webview.html = getWebviewHtml(currentPanel.webview, distWebview);

  currentPanel.webview.onDidReceiveMessage(
    (msg: ToExtension) => handleMessage(msg, currentPanel!, context),
    null,
    context.subscriptions,
  );

  currentPanel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);
}

function post(panel: vscode.WebviewPanel, msg: ToWebview) {
  panel.webview.postMessage(msg);
}

async function handleMessage(
  msg: ToExtension,
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
) {
  switch (msg.type) {
    case 'ready': {
      const secrets = context.secrets;
      const token = await secrets.get('tornaToken');
      post(panel, { type: 'tokenState', hasToken: !!token });
      const dir = vscode.workspace.getConfiguration('openapiQoder').get<string>('outputDir') ?? 'src/api';
      post(panel, { type: 'outputDir', dir });
      checkQodercli(panel);
      break;
    }
    case 'saveToken': {
      await context.secrets.store('tornaToken', msg.token);
      post(panel, { type: 'tokenState', hasToken: true });
      break;
    }
    case 'loadTree': {
      await loadTree(msg.urlOrId, panel, context);
      break;
    }
    case 'generate': {
      generateAbort = new AbortController();
      const out = getOutput();
      out.show(true);
      out.appendLine(`\n--- 生成开始 ${new Date().toLocaleTimeString()} ---`);

      // Pre-flight diagnostics — if these are empty, nothing will happen.
      const diag = `tree=${lastTree.length} nodes, token=${lastToken ? 'set' : 'EMPTY'}, baseUrl=${lastBaseUrl || 'EMPTY'}, selected=${msg.selection.length}`;
      out.appendLine(`[diag] ${diag}`);
      post(panel, { type: 'log', message: `[诊断] ${diag}` });
      post(panel, { type: 'progress', message: '正在初始化...' });

      if (!lastToken) {
        post(panel, { type: 'error', message: '未配置 Token（请先加载一次接口树）' });
        break;
      }
      if (lastTree.length === 0) {
        post(panel, { type: 'error', message: '接口树为空（请先粘贴地址并加载）' });
        break;
      }
      if (msg.selection.length === 0) {
        post(panel, { type: 'error', message: '未选中任何接口' });
        break;
      }

      try {
        const result = await generateAndWrite({
          selectedIds: msg.selection,
          tree: lastTree,
          options: msg.options,
          token: lastToken,
          baseUrl: lastBaseUrl,
          projectId: lastProjectId,
          signal: generateAbort.signal,
          onProgress: (m) => post(panel, { type: 'progress', message: m }),
          onLog: (m) => { out.appendLine(m); post(panel, { type: 'log', message: m }); },
        });
        out.appendLine(`--- 完成: ${result.files.length} 个文件 ---`);
        post(panel, { type: 'done', files: result.files });
      } catch (err) {
        const errMsg = (err as Error).message ?? String(err);
        out.appendLine(`--- 错误: ${errMsg} ---`);
        post(panel, { type: 'error', message: errMsg });
      } finally {
        generateAbort = undefined;
      }
      break;
    }
    case 'cancel': {
      if (generateAbort) {
        generateAbort.abort();
        getOutput().appendLine('--- 用户取消 ---');
      }
      break;
    }
    case 'pickOutputDir': {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: '选择输出目录',
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      if (uris?.[0] && vscode.workspace.workspaceFolders?.[0]) {
        const rel = path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, uris[0].fsPath);
        await vscode.workspace.getConfiguration('openapiQoder').update('outputDir', rel, vscode.ConfigurationTarget.Workspace);
        post(panel, { type: 'outputDir', dir: rel });
      }
      break;
    }
  }
}

async function loadTree(urlOrId: string, panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
  try {
    const { parseDocUrl, buildFolderTree } = await import('../../src/core/index.js');
    const { TornaClient } = await import('../../src/torna/client.js');

    const parsed = parseDocUrl(urlOrId);
    if (!parsed) { post(panel, { type: 'error', message: '无法解析地址' }); return; }

    const token = await context.secrets.get('tornaToken');
    if (!token) { post(panel, { type: 'error', message: '未配置 Token' }); return; }

    const baseUrl = (parsed.baseUrl ?? 'https://doc-dev.qijiswap.com').replace(/\/$/, '');
    const client = new TornaClient({ baseUrl, token });

    const detail = await client.getDetail(parsed.id) as any;
    const projectId: string = detail.projectId;
    if (!projectId) { post(panel, { type: 'error', message: '该文档没有 projectId' }); return; }

    const nodes = await client.getApiTree(projectId);
    const tree = buildFolderTree(nodes) as TreeNodeMsg[];
    lastTree = tree;
    lastBaseUrl = baseUrl;
    lastProjectId = projectId;
    lastToken = token;
    post(panel, { type: 'treeLoaded', tree, projectId });
  } catch (err) {
    post(panel, { type: 'error', message: `加载失败: ${(err as Error).message}` });
  }
}

async function checkQodercli(panel: vscode.WebviewPanel) {
  const { execFile } = await import('node:child_process');
  const cmd = vscode.workspace.getConfiguration('openapiQoder').get<string>('qodercliPath') ?? 'qodercli';
  execFile(cmd, ['--version'], (err) => {
    post(panel, { type: 'qodercliAvailable', available: !err });
  });
}

function getWebviewHtml(webview: vscode.Webview, distDir: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const indexPath = path.join(distDir, 'index.html');

  if (!fs.existsSync(indexPath)) {
    return `<!DOCTYPE html><html><body><h2>Webview 尚未构建</h2><p>运行 <code>pnpm --filter openapi-qoder-webview build</code></p></body></html>`;
  }

  let html = fs.readFileSync(indexPath, 'utf8');

  // Rewrite asset paths to use webview URIs
  html = html.replace(/(href|src)="(\.?\/?assets\/[^"]+)"/g, (_match, attr, relPath) => {
    const uri = webview.asWebviewUri(vscode.Uri.file(path.join(distDir, relPath)));
    return `${attr}="${uri}"`;
  });

  // Inject CSP
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `connect-src ${webview.cspSource}`,
  ].join('; ');

  html = html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  // Add nonce to script tags
  html = html.replace(/<script /g, `<script nonce="${nonce}" `);

  return html;
}

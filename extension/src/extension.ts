import * as vscode from 'vscode';
import { createPanel } from './panel';

const EXT_VERSION = '0.1.0-build5';

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('OpenAPI Qoder');
  out.appendLine(`[activate] OpenAPI Qoder ${EXT_VERSION} 已激活`);

  context.subscriptions.push(
    vscode.commands.registerCommand('openapiQoder.open', () => {
      createPanel(context);
    }),
  );
}

export function deactivate() {}

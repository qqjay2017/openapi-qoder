import * as vscode from 'vscode';
import { createPanel } from './panel';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('openapiQoder.open', () => {
      createPanel(context);
    }),
  );
}

export function deactivate() {}

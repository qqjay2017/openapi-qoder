import type { ToExtension, ToWebview } from '../../src/shared/protocol';

declare function acquireVsCodeApi(): { postMessage(msg: ToExtension): void; getState(): any; setState(s: any): void };

const vscode = acquireVsCodeApi();

export function postToExtension(msg: ToExtension) {
  vscode.postMessage(msg);
}

export function onMessage(handler: (msg: ToWebview) => void) {
  window.addEventListener('message', (e: MessageEvent<ToWebview>) => handler(e.data));
}

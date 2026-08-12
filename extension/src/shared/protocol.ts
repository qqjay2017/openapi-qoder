// Messages between the webview (Vue) and the extension host.
// Both sides import this file for type safety.

export interface TreeNodeMsg {
  id: string;
  docId: string | null;
  label: string;
  url: string;
  httpMethod: string;
  type: number; // 1=service group, 2=folder, 3=api leaf
  apiCount: number;
  children: TreeNodeMsg[];
}

// Webview → Extension
export type ToExtension =
  | { type: 'saveToken'; token: string }
  | { type: 'loadTree'; urlOrId: string }
  | { type: 'generate'; selection: string[]; options: GenerateOptions }
  | { type: 'pickOutputDir' }
  | { type: 'cancel' }
  | { type: 'ready' };

export interface GenerateOptions {
  requestFns: boolean;
  enums: boolean;
  options: boolean;
  aiPolish: boolean;
}

// Extension → Webview
export type ToWebview =
  | { type: 'tokenState'; hasToken: boolean }
  | { type: 'treeLoaded'; tree: TreeNodeMsg[]; projectId: string }
  | { type: 'progress'; message: string }
  | { type: 'log'; message: string }
  | { type: 'done'; files: string[] }
  | { type: 'error'; message: string }
  | { type: 'outputDir'; dir: string }
  | { type: 'qodercliAvailable'; available: boolean };

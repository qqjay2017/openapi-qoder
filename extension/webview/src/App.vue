<script setup lang="ts">
import { ref, computed, onMounted, toRaw } from 'vue';
import { postToExtension, onMessage } from './vscode';
import type { TreeNodeMsg, GenerateOptions } from '../../src/shared/protocol';
import TreeItem from './TreeItem.vue';

type Phase = 'token' | 'tree' | 'generating';

const phase = ref<Phase>('token');
const tokenInput = ref('');
const urlInput = ref('');
const tree = ref<TreeNodeMsg[]>([]);
const selected = ref<Set<string>>(new Set());
const loading = ref(false);
const progress = ref('');
const errorMsg = ref('');
const generatedFiles = ref<string[]>([]);
const outputDir = ref('src/api');
const qodercliAvailable = ref(false);
const logs = ref<string[]>([]);
const extVersion = ref('');

const opts = ref<GenerateOptions>({
  requestFns: true,
  enums: true,
  options: false,
  aiPolish: false,
});

const selectedCount = computed(() => selected.value.size);

function saveToken() {
  if (!tokenInput.value.trim()) return;
  postToExtension({ type: 'saveToken', token: tokenInput.value.trim() });
}

function loadTree() {
  if (!urlInput.value.trim()) return;
  loading.value = true;
  errorMsg.value = '';
  postToExtension({ type: 'loadTree', urlOrId: urlInput.value.trim() });
}

function toggleNode(node: TreeNodeMsg, checked: boolean) {
  const leaves = collectLeaves(node);
  for (const l of leaves) {
    if (checked) selected.value.add(l.id);
    else selected.value.delete(l.id);
  }
  selected.value = new Set(selected.value);
}

function collectLeaves(node: TreeNodeMsg): TreeNodeMsg[] {
  if (node.type === 3 && node.docId) return [node];
  return node.children.flatMap(collectLeaves);
}

function generate() {
  if (selected.value.size === 0) return;
  phase.value = 'generating';
  progress.value = '准备中...';
  errorMsg.value = '';
  generatedFiles.value = [];
  logs.value = [];
  try {
    const msg = {
      type: 'generate' as const,
      selection: [...selected.value],
      options: JSON.parse(JSON.stringify(toRaw(opts.value))) as GenerateOptions,
    };
    logs.value.push(`[webview] 发送消息: selection=${msg.selection.length}, options=${JSON.stringify(msg.options)}`);
    postToExtension(msg);
  } catch (err) {
    logs.value.push(`[webview] 发送失败: ${(err as Error).message}`);
    errorMsg.value = `消息发送失败: ${(err as Error).message}`;
    phase.value = 'tree';
  }
}

function cancel() {
  try {
    postToExtension({ type: 'cancel' });
    logs.value.push('[webview] 已发送取消');
  } catch (err) {
    logs.value.push(`[webview] 取消发送失败: ${(err as Error).message}`);
  }
}

function pickDir() {
  postToExtension({ type: 'pickOutputDir' });
}

onMounted(() => {
  postToExtension({ type: 'ready' });
});

onMessage((msg) => {
  switch (msg.type) {
    case 'tokenState':
      phase.value = msg.hasToken ? 'tree' : 'token';
      if (msg.version) extVersion.value = msg.version;
      break;
    case 'treeLoaded':
      tree.value = msg.tree;
      loading.value = false;
      break;
    case 'progress':
      progress.value = msg.message;
      break;
    case 'log':
      logs.value.push(msg.message);
      break;
    case 'done':
      generatedFiles.value = msg.files;
      phase.value = 'tree';
      progress.value = '';
      break;
    case 'error':
      loading.value = false;
      if (msg.message.includes('取消')) {
        logs.value.push('[已取消]');
        phase.value = 'tree';
      } else {
        errorMsg.value = msg.message;
        if (phase.value === 'generating') phase.value = 'tree';
      }
      break;
    case 'outputDir':
      outputDir.value = msg.dir;
      break;
    case 'qodercliAvailable':
      qodercliAvailable.value = msg.available;
      break;
  }
});
</script>

<template>
  <div class="container">
    <!-- Token Setup -->
    <section v-if="phase === 'token'" class="phase-token">
      <h2>配置 Torna Token</h2>
      <p class="hint">Token 安全存储在 VS Code SecretStorage 中，不会写入 settings.json。</p>
      <input
        v-model="tokenInput"
        type="password"
        placeholder="粘贴 Torna token 请求头的值"
        @keyup.enter="saveToken"
      />
      <button @click="saveToken" :disabled="!tokenInput.trim()">保存</button>
    </section>

    <!-- Tree + Generate -->
    <section v-else-if="phase === 'tree'" class="phase-tree">
      <div class="url-bar">
        <input
          v-model="urlInput"
          placeholder="粘贴文档地址 如 https://doc-dev.qijiswap.com/#/view/K8MmPR78"
          @keyup.enter="loadTree"
        />
        <button @click="loadTree" :disabled="loading || !urlInput.trim()">
          {{ loading ? '加载中...' : '加载' }}
        </button>
      </div>

      <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
      <div v-if="generatedFiles.length" class="success">
        已生成 {{ generatedFiles.length }} 个文件到 {{ outputDir }}/
      </div>

      <div v-if="tree.length" class="tree-container">
        <TreeItem
          v-for="node in tree"
          :key="node.id"
          :node="node"
          :selected="selected"
          :depth="0"
          @toggle="toggleNode"
        />
      </div>

      <div v-if="tree.length" class="options-bar">
        <label><input type="checkbox" v-model="opts.requestFns" /> 接口函数</label>
        <label><input type="checkbox" v-model="opts.enums" /> 枚举</label>
        <label><input type="checkbox" v-model="opts.options" /> Options</label>
        <label :class="{ disabled: !qodercliAvailable }">
          <input type="checkbox" v-model="opts.aiPolish" :disabled="!qodercliAvailable" />
          AI 润色
          <span v-if="!qodercliAvailable" class="hint">(需安装 qodercli)</span>
        </label>
      </div>

      <div v-if="tree.length" class="action-bar">
        <span class="output-dir" @click="pickDir">输出到: {{ outputDir }}/</span>
        <button @click="generate" :disabled="selectedCount === 0">
          生成选中项 ({{ selectedCount }})
        </button>
      </div>
    </section>

    <!-- Generating -->
    <section v-else class="phase-generating">
      <h2>生成中...</h2>
      <p class="progress-text">{{ progress }}</p>
      <div class="log-panel" ref="logPanel">
        <div v-for="(line, i) in logs" :key="i" class="log-line">{{ line }}</div>
        <div v-if="logs.length === 0" class="log-line hint">等待后台操作...</div>
      </div>
      <p class="hint">详细日志也输出到「输出」面板 → OpenAPI Qoder 频道</p>
      <button class="cancel-btn" @click="cancel">取消</button>
    </section>

    <div class="version-badge" v-if="extVersion">ext: {{ extVersion }}</div>
    <div class="version-badge version-warn" v-else>⚠ 未收到扩展版本（请 Reload Window）</div>
  </div>
</template>

<style>
:root {
  --pad: 12px;
}
body {
  font-family: var(--vscode-font-family, sans-serif);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: var(--pad);
}
.container { max-width: 680px; }
h2 { font-size: 1.2em; margin: 0 0 8px; }
.hint { font-size: 0.85em; opacity: 0.6; }
input[type="text"], input[type="password"], input:not([type]) {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  margin: 6px 0;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
}
button {
  padding: 6px 14px;
  margin: 4px 0;
  cursor: pointer;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 3px;
}
button:disabled { opacity: 0.5; cursor: default; }
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.url-bar { display: flex; gap: 8px; align-items: center; }
.url-bar input { flex: 1; }
.error { color: var(--vscode-errorForeground); margin: 8px 0; }
.success { color: var(--vscode-terminal-ansiGreen, #4ec9b0); margin: 8px 0; }
.tree-container { margin: 12px 0; max-height: 400px; overflow-y: auto; }
.options-bar { display: flex; gap: 14px; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--vscode-widget-border, #333); }
.options-bar label { display: flex; align-items: center; gap: 4px; font-size: 0.9em; cursor: pointer; }
.options-bar .disabled { opacity: 0.5; }
.action-bar { display: flex; justify-content: space-between; align-items: center; padding-top: 8px; }
.output-dir { font-size: 0.85em; opacity: 0.7; cursor: pointer; text-decoration: underline; }
.progress-text { font-weight: 500; margin: 8px 0 4px; }
.log-panel {
  max-height: 220px;
  overflow-y: auto;
  background: var(--vscode-terminal-background, #1e1e1e);
  border: 1px solid var(--vscode-widget-border, #333);
  border-radius: 4px;
  padding: 8px;
  margin: 8px 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.8em;
  line-height: 1.5;
}
.log-line { white-space: pre-wrap; word-break: break-all; }
.cancel-btn {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ccc);
  margin-top: 8px;
}
.cancel-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.version-badge { position: fixed; bottom: 4px; right: 8px; font-size: 0.7em; opacity: 0.4; }
.version-warn { opacity: 0.9; color: var(--vscode-errorForeground, #f44); }
</style>

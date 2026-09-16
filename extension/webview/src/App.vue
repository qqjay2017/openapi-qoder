<script setup lang="ts">
import { ref, computed, onMounted, toRaw } from 'vue';
import { postToExtension, onMessage } from './vscode';
import type { TreeNodeMsg, GenerateOptions, PolishReportMsg } from '../../src/shared/protocol';
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
const polishReport = ref<PolishReportMsg[]>([]);
const outputDir = ref('src/api');
const hasPat = ref(false);
const patInput = ref('');
const showPatInput = ref(false);
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

function savePat() {
  if (!patInput.value.trim()) return;
  postToExtension({ type: 'savePat', token: patInput.value.trim() });
  patInput.value = '';
  showPatInput.value = false;
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
  polishReport.value = [];
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

function showDiff(file: string) {
  postToExtension({ type: 'showDiff', file });
}

onMounted(() => {
  postToExtension({ type: 'ready' });
});

onMessage((msg) => {
  switch (msg.type) {
    case 'tokenState':
      phase.value = msg.hasToken ? 'tree' : 'token';
      hasPat.value = msg.hasPat;
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
      polishReport.value = msg.polish ?? [];
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

      <div v-if="polishReport.length" class="polish-report">
        <div class="polish-title">AI 润色结果（点文件名看对比）</div>
        <div v-for="r in polishReport" :key="r.file" class="polish-row">
          <span class="polish-status" :class="r.status">
            {{ r.status === 'polished' ? '✓' : r.status === 'reverted' ? '↺' : '✗' }}
          </span>
          <span class="polish-file" @click="showDiff(r.file)">{{ r.name }}</span>
          <span v-if="r.status === 'polished'" class="polish-detail">
            <template v-if="r.renames.length">
              {{ r.renames.length }} 处重命名：{{ r.renames.slice(0, 3).map(x => x.from + '→' + x.to).join('、') }}{{ r.renames.length > 3 ? ' …' : '' }}
            </template>
            <template v-if="r.typeReuse">，{{ r.typeReuse }} 处类型复用</template>
            <template v-if="r.unknownResolved">，{{ r.unknownResolved }} 处 unknown[] 定型</template>
            <template v-if="r.otherLines">，{{ r.otherLines }} 行结构/注释调整</template>
            <template v-if="!r.renames.length && !r.typeReuse && !r.unknownResolved && !r.otherLines">无实质变化</template>
          </span>
          <span v-else-if="r.status === 'reverted'" class="polish-detail">
            契约或编译检查失败，已回滚为 Stage-1
          </span>
          <span v-else class="polish-detail">润色未完成，保留 Stage-1</span>
        </div>
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
        <label :class="{ disabled: !hasPat }">
          <input type="checkbox" v-model="opts.aiPolish" :disabled="!hasPat" />
          AI 润色
          <span class="hint pat-toggle" @click.prevent="showPatInput = !showPatInput">
            {{ hasPat ? '(已配置令牌，点击重设)' : '(需配置 Qoder 令牌)' }}
          </span>
        </label>
      </div>

      <div v-if="tree.length && showPatInput" class="pat-panel">
        <p class="hint">
          在 https://qoder.com/account/integrations 创建个人访问令牌（pt- 开头）。
          令牌安全存储在 VS Code SecretStorage 中，不会写入 settings.json。
        </p>
        <div class="url-bar">
          <input
            v-model="patInput"
            type="password"
            placeholder="粘贴 Qoder 个人访问令牌"
            @keyup.enter="savePat"
          />
          <button @click="savePat" :disabled="!patInput.trim()">保存</button>
        </div>
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
  --pad: 16px;
}
body {
  font-family: var(--vscode-font-family, sans-serif);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: var(--pad);
  font-size: 15px;
  line-height: 1.6;
}
.container { max-width: 820px; }
h2 { font-size: 1.5em; margin: 0 0 12px; }
.hint { font-size: 0.9em; opacity: 0.65; }
input[type="text"], input[type="password"], input:not([type]) {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  margin: 8px 0;
  font-size: 1em;
  font-family: inherit;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
}
button {
  padding: 9px 18px;
  margin: 6px 0;
  font-size: 1em;
  font-family: inherit;
  cursor: pointer;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
}
button:disabled { opacity: 0.5; cursor: default; }
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
.url-bar { display: flex; gap: 10px; align-items: center; }
.url-bar input { flex: 1; }
.error { color: var(--vscode-errorForeground); margin: 10px 0; font-size: 0.95em; }
.success { color: var(--vscode-terminal-ansiGreen, #4ec9b0); margin: 10px 0; font-size: 0.95em; }
.tree-container { margin: 14px 0; max-height: 440px; overflow-y: auto; }
.options-bar { display: flex; gap: 18px; flex-wrap: wrap; padding: 12px 0; border-top: 1px solid var(--vscode-widget-border, #333); }
.options-bar label { display: flex; align-items: center; gap: 6px; font-size: 0.95em; cursor: pointer; }
.options-bar .disabled { opacity: 0.5; }
.pat-toggle { cursor: pointer; text-decoration: underline; }
.pat-panel { padding: 10px 0; }
.polish-report {
  margin: 10px 0;
  padding: 10px 12px;
  border: 1px solid var(--vscode-widget-border, #333);
  border-radius: 4px;
  font-size: 0.9em;
}
.polish-title { font-weight: 500; margin-bottom: 6px; }
.polish-row { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
.polish-status.polished { color: var(--vscode-terminal-ansiGreen, #4ec9b0); }
.polish-status.reverted { color: var(--vscode-terminal-ansiYellow, #d7ba7d); }
.polish-status.failed { color: var(--vscode-errorForeground, #f44); }
.polish-file { cursor: pointer; text-decoration: underline; white-space: nowrap; }
.polish-detail { opacity: 0.7; word-break: break-all; }
.action-bar { display: flex; justify-content: space-between; align-items: center; padding-top: 12px; }
.output-dir { font-size: 0.9em; opacity: 0.75; cursor: pointer; text-decoration: underline; }
.progress-text { font-weight: 500; margin: 10px 0 6px; font-size: 1.05em; }
.log-panel {
  max-height: 300px;
  overflow-y: auto;
  background: var(--vscode-terminal-background, #1e1e1e);
  border: 1px solid var(--vscode-widget-border, #333);
  border-radius: 4px;
  padding: 10px;
  margin: 10px 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.9em;
  line-height: 1.6;
}
.log-line { white-space: pre-wrap; word-break: break-all; }
.cancel-btn {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ccc);
  margin-top: 10px;
}
.cancel-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.version-badge { position: fixed; bottom: 6px; right: 10px; font-size: 0.78em; opacity: 0.4; }
.version-warn { opacity: 0.9; color: var(--vscode-errorForeground, #f44); }
</style>

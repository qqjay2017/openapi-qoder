<script setup lang="ts">
import { computed } from 'vue';
import type { TreeNodeMsg } from '../../src/shared/protocol';

const props = defineProps<{
  node: TreeNodeMsg;
  selected: Set<string>;
  depth: number;
}>();

const emit = defineEmits<{
  toggle: [node: TreeNodeMsg, checked: boolean];
}>();

function collectLeaves(n: TreeNodeMsg): TreeNodeMsg[] {
  if (n.type === 3 && n.docId) return [n];
  return n.children.flatMap(collectLeaves);
}

const leaves = computed(() => collectLeaves(props.node));
const checkedCount = computed(() => leaves.value.filter((l) => props.selected.has(l.id)).length);
const isChecked = computed(() => leaves.value.length > 0 && checkedCount.value === leaves.value.length);
const isIndeterminate = computed(() => checkedCount.value > 0 && checkedCount.value < leaves.value.length);
const isLeaf = computed(() => props.node.type === 3);

function toggle(e: Event) {
  const checked = (e.target as HTMLInputElement).checked;
  emit('toggle', props.node, checked);
}

function onChildToggle(child: TreeNodeMsg, checked: boolean) {
  emit('toggle', child, checked);
}

const icon = computed(() => {
  if (props.node.type === 1) return '📦';
  if (props.node.type === 2) return '📁';
  return '';
});

const label = computed(() => {
  if (isLeaf.value) {
    const method = props.node.httpMethod || 'POST';
    return `${method} ${props.node.url}  — ${props.node.label}`;
  }
  const count = leaves.value.length;
  return `${props.node.label}${count ? ` (${count})` : ''}`;
});
</script>

<template>
  <div class="tree-item" :style="{ paddingLeft: depth * 16 + 'px' }">
    <label class="node-label">
      <input
        type="checkbox"
        :checked="isChecked"
        :indeterminate="isIndeterminate"
        @change="toggle"
      />
      <span v-if="icon" class="icon">{{ icon }}</span>
      <span :class="{ leaf: isLeaf }">{{ label }}</span>
    </label>
    <div v-if="!isLeaf && node.children.length" class="children">
      <TreeItem
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :selected="selected"
        :depth="depth + 1"
        @toggle="onChildToggle"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-item { line-height: 1.6; }
.node-label { display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 0.9em; }
.icon { font-size: 0.85em; }
.leaf { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; opacity: 0.85; }
</style>

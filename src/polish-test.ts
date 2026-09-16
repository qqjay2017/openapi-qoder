import { buildCloudPolishPrompt } from './polish/prompt.js';
import { extractTypeDesign, validatePolishedSource } from './polish/validate.js';

let failures = 0;

function check(label: string, result: { ok: boolean; errors: string[] }, expected: boolean): void {
  const ok = result.ok === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ${result.errors.join(' | ')}`}`);
  if (!ok) failures++;
}

function checkValue(label: string, ok: boolean): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const before = `
import request from '@/utils/request';
import type { PageResult } from './common.js';

export const STATUS = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
} as const;
export type Status = typeof STATUS[keyof typeof STATUS];
export enum Priority {
  LOW = 'LOW',
  HIGH = 'HIGH',
}

export interface QueryParam {
  id: string;
  status?: Status;
  tags?: unknown[];
}
export interface ItemDto {
  id: string;
  name?: string;
  status?: Status;
  priority?: Priority;
}
export interface DuplicateItemDto {
  id: string;
  name?: string;
  status?: Status;
  priority?: Priority;
}
export type QueryData = PageResult<ItemDto>;

export const queryItems = (data: QueryParam) =>
  request.post<QueryData, QueryParam>('/items/page', data);
`;

const polished = `
import type { PageResult } from './common.js';
import request from '@/utils/request';

export const STATUS = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
} as const;
export type ItemStatus = typeof STATUS[keyof typeof STATUS];
export enum ItemPriority {
  LOW = 'LOW',
  HIGH = 'HIGH',
}

export interface ItemEntity {
  id: string;
  name?: string;
  status?: ItemStatus;
  priority?: ItemPriority;
  internalNote?: string;
}
export interface ItemQuery extends Pick<ItemEntity, 'id' | 'status'> {
  tags?: string[];
}
export type ItemVO = Omit<ItemEntity, 'internalNote'>;
export type ItemAlias = ItemVO;
export type ItemPage = PageResult<ItemVO>;

export const getItemPage = (input: ItemQuery) =>
  request.post<ItemPage, ItemQuery>('/items/page', input);
`;

console.log('\naccepted Stage-2 refactors');
check(
  'expands public base/extends, Pick/Omit and aliases; permits unknown[] narrowing',
  validatePolishedSource(before, polished),
  true,
);

console.log('\ncontract failures');
check(
  'rejects a deleted field',
  validatePolishedSource(before, polished.replace('  name?: string;\n', '')),
  false,
);
check(
  'rejects changed optionality',
  validatePolishedSource(before, polished.replace('  name?: string;', '  name: string;')),
  false,
);
check(
  'rejects a changed known type',
  validatePolishedSource(before, polished.replace('  status?: ItemStatus;', '  status?: string;')),
  false,
);
check(
  'rejects a changed readonly modifier',
  validatePolishedSource(before, polished.replace('  id: string;', '  readonly id: string;')),
  false,
);
check(
  'rejects a changed URL',
  validatePolishedSource(before, polished.replace("'/items/page'", "'/items/list'")),
  false,
);
check(
  'rejects a changed HTTP method',
  validatePolishedSource(before, polished.replace('request.post<', 'request.get<')),
  false,
);
check(
  'rejects changed runtime parameter passing',
  validatePolishedSource(before, polished.replace("('/items/page', input)", "('/items/page', { input })")),
  false,
);
check(
  'rejects any',
  validatePolishedSource(before, polished.replace('tags?: string[];', 'tags?: any[];')),
  false,
);
check(
  'rejects as assertions',
  validatePolishedSource(before, polished.replace("('/items/page', input)", "('/items/page', input as ItemQuery)")),
  false,
);
check(
  'rejects non-null assertions',
  validatePolishedSource(before, polished.replace("('/items/page', input)", "('/items/page', input!)")),
  false,
);

console.log('\nincremental polish context');
{
  const previousContent = extractTypeDesign(polished);
  checkValue('keeps previous type abstractions', previousContent.includes('interface ItemQuery'));
  checkValue('drops previous runtime request code', !previousContent.includes('request.post'));
  const prompt = buildCloudPolishPrompt([
    {
      file: '/tmp/items.ts',
      name: 'items.ts',
      apis: [{ docName: '查询列表', url: '/items/page', httpMethod: 'POST' }],
      stage1Content: before,
      content: before,
      previousContent,
    },
  ]);
  checkValue('labels the old design as reference-only', prompt.includes('PREVIOUS VALIDATED TYPE DESIGN'));
  checkValue('keeps the current source as the contract', prompt.includes('CURRENT SOURCE TO POLISH'));
}

console.log(failures === 0 ? '\nAll polish validator checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;

// Stage-1 emitter tests (hermetic: pure functions, no network, no AI, no fixtures).
//
// Covers the naming edge cases that are silent at compile time and only surface
// at runtime, which is exactly what the Stage-2 tsc gate cannot catch.

import { generateFile, type TornaDetail } from './codegen/emit.js';
import type { RawParam } from './codegen/tree.js';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

function param(id: string, parentId: string, name: string, type: string): RawParam {
  return { id, parentId, name, type, required: 1 };
}

function gen(url: string, responseParams: RawParam[], requestParams: RawParam[] = []): string {
  const detail: TornaDetail = {
    id: 'doc1',
    docName: 'test',
    url,
    httpMethod: 'POST',
    requestParams,
    responseParams,
  };
  return generateFile(detail);
}

console.log('\ncolliding mechanical names');
{
  // `fooBar` and `foo_bar` both pascal-case to `FooBar`.
  const code = gen('/2m/v1/baz/get', [
    param('1', '', 'data', 'object'),
    param('2', '1', 'fooBar', 'object'),
    param('3', '2', 'a', 'string'),
    param('4', '1', 'foo_bar', 'object'),
    param('5', '4', 'totallyDifferent', 'int'),
  ]);
  check('emits a second interface for the diverging shape', code.includes('BazGetDataFooBar2'));
  check('keeps the shadowed field', code.includes('totallyDifferent: number;'));
  check('the two props get different types', /foo_bar: BazGetDataFooBar2;/.test(code));
}

console.log('\nidentical shapes under a colliding name are shared');
{
  const code = gen('/2m/v1/baz/get', [
    param('1', '', 'data', 'object'),
    param('2', '1', 'fooBar', 'object'),
    param('3', '2', 'a', 'string'),
    param('4', '1', 'foo_bar', 'object'),
    param('5', '4', 'a', 'string'),
  ]);
  check('no needless duplicate', !code.includes('BazGetDataFooBar2'));
  check(
    'declared exactly once',
    (code.match(/export interface BazGetDataFooBar \{/g) ?? []).length === 1,
  );
}

console.log('\nTorna placeholder field name');
{
  // Array elements arrive named "-", which pascal-cases to ''.
  const code = gen('/2m/v1/bar/get', [
    param('1', '', 'data', 'object'),
    param('2', '1', '-', 'object'),
    param('3', '2', 'vin', 'string'),
  ]);
  check('does not make the type reference itself', !/"-": BarGetData;/.test(code));
  check('names the placeholder sub-interface', code.includes('export interface BarGetDataItem {'));
  check('keeps the placeholder key quoted', code.includes('"-": BarGetDataItem;'));
}

console.log('\nsingularize stripping a name to nothing');
{
  const code = gen('/2m/v1/bar/get', [
    param('1', '', 'data', 'object'),
    param('2', '1', 'List', 'array'),
    param('3', '2', 'vin', 'string'),
  ]);
  check('falls back instead of colliding with the owner', code.includes('List: BarGetDataItem[];'));
  check('sub-interface exists', code.includes('export interface BarGetDataItem {'));
}

console.log('\npagination detection');
{
  const paged = gen('/2m/v1/foo/page', [
    param('1', '', 'data', 'object'),
    param('2', '1', 'totalCount', 'int'),
    param('3', '1', 'pageObject', 'array'),
    param('4', '3', 'vin', 'string'),
  ]);
  check('wraps in PageResult', paged.includes('export type FooPageData = PageResult<FooPageItem>;'));
  check('imports PageResult', paged.includes("import type { PageResult } from './common.js';"));

  const unpaged = gen('/2m/v1/foo/page', [
    param('1', '', 'data', 'object'),
    param('2', '1', 'pageObject', 'array'),
    param('3', '2', 'vin', 'string'),
  ]);
  check('no totalCount => not a page', !unpaged.includes('PageResult'));
}

console.log('\nrequest function');
{
  const code = gen('/2m/v1.0/foo/page', [param('1', '', 'data', 'string')]);
  check('drops the gateway prefix but keeps the version', code.includes("('/v1.0/foo/page'"));
  check('type names drop the version', code.includes('export type FooPageData'));
  check('references the emitted names', code.includes('request.post<FooPageData, FooPageParam>'));

  const get = generateFile({
    id: 'd',
    docName: 'g',
    url: '/2m/v1/foo/list',
    httpMethod: 'GET',
    requestParams: [param('1', '', 'vin', 'string')],
    responseParams: [],
  });
  check(
    'GET passes params',
    get.includes("request.get<FooListData, FooListParam>('/v1/foo/list', { params })"),
  );
}

console.log(failures === 0 ? '\nAll emitter checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;

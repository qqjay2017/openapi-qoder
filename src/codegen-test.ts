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

console.log('\ngeneration switches');
{
  const enumParam: RawParam = {
    id: '1',
    parentId: '',
    name: 'bizType',
    type: 'string',
    required: 1,
    description: 'business type[Enum: PASSENGER("BIZ_P", "乘用车")<br/>, TRUCK("BIZ_T", "轻卡")<br/>]',
    enumId: 'e1',
    enumInfo: {
      id: 'e1',
      items: [
        { name: 'PASSENGER', value: 'BIZ_P', description: '乘用车' },
        { name: 'TRUCK', value: 'BIZ_T', description: '轻卡' },
      ],
    },
  };
  const detail: TornaDetail = {
    id: 'd1',
    docName: 'sw',
    url: '/2m/v1/foo/page',
    httpMethod: 'POST',
    requestParams: [enumParam],
    responseParams: [param('9', '', 'data', 'string')],
  };

  const dflt = generateFile(detail);
  check('default emits the request fn', dflt.includes('export const fooPage ='));
  check('default emits the enum', dflt.includes('export const BIZ_TYPE = {'));
  check('default types the field as the enum', dflt.includes('bizType: BizType;'));
  check('default emits no options array', !dflt.includes('_OPTIONS'));

  const noFns = generateFile(detail, { requestFns: false });
  check('requestFns:false drops the fn', !noFns.includes('export const fooPage ='));
  check('requestFns:false drops the request import', !noFns.includes("import request from"));
  check('requestFns:false keeps the types', noFns.includes('export interface FooPageParam {'));

  const noEnums = generateFile(detail, { enums: false });
  check('enums:false emits no enum const', !noEnums.includes('BIZ_TYPE'));
  check('enums:false degrades the field to its scalar', noEnums.includes('bizType: string;'));

  const withOptions = generateFile(detail, { options: true });
  check('options:true emits the array', withOptions.includes('export const BIZ_TYPE_OPTIONS = ['));
  check(
    'options values reference the enum const',
    withOptions.includes("{ label: '乘用车', value: BIZ_TYPE.PASSENGER },"),
  );
  check('options:true still emits the enum', withOptions.includes('export const BIZ_TYPE = {'));
}

console.log(failures === 0 ? '\nAll emitter checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;

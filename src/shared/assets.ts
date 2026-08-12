// Infrastructure files that ship *next to* generated output.
//
// These are held as string constants rather than real files on disk because the
// generator also runs inside a bundled VS Code extension, where there is no repo
// checkout to copy from. `emit.ts` emits `import type { PageResult } from
// './common.js'`, so common.ts must still be written as a real sibling file into
// whatever directory the output lands in.

export const COMMON_TS = `// Shared types distributed alongside generated interfaces.

/** 统一分页返回体（字段名以 Torna 实际返回为准） */
export interface PageResult<T> {
  pageObject: T[];
  pageIndex: number;
  pageSize: number;
  totalPage: number;
  totalCount: number;
}
`;

export const REQUEST_STUB_TS = `// Test-only stub so generated request files type-check standalone.
// Real projects resolve '@/utils/request' to their own axios wrapper.
declare const request: {
  post<TData, TBody = unknown>(url: string, data?: TBody): Promise<TData>;
  get<TData, TParams = unknown>(url: string, config?: { params?: TParams }): Promise<TData>;
  put<TData, TBody = unknown>(url: string, data?: TBody): Promise<TData>;
  delete<TData, TBody = unknown>(url: string, data?: TBody): Promise<TData>;
};
export default request;
`;

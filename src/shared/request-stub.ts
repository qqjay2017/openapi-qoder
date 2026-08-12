// Test-only stub so generated request files type-check standalone.
// Real projects resolve '@/utils/request' to their own axios wrapper.
declare const request: {
  post<TData, TBody = unknown>(url: string, data?: TBody): Promise<TData>;
  get<TData, TParams = unknown>(url: string, config?: { params?: TParams }): Promise<TData>;
  put<TData, TBody = unknown>(url: string, data?: TBody): Promise<TData>;
  delete<TData, TBody = unknown>(url: string, data?: TBody): Promise<TData>;
};
export default request;

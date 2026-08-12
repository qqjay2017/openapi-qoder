// Shared types distributed alongside generated interfaces.

/** 统一分页返回体（字段名以 Torna 实际返回为准） */
export interface PageResult<T> {
  pageObject: T[];
  pageIndex: number;
  pageSize: number;
  totalPage: number;
  totalCount: number;
}

// 参考样例（手写）：期望的输出风格示意，不是快照断言，无代码读取它。
// 真正的 emitter 断言在 src/codegen-test.ts。

export interface RootObject {
    operatorTenantId: string
    pageIndex: number
    pageSize: number
    vin: string
    vehiclePlate: string
    vehicleType: string
    vehicleModel: string
    assetOwnerName: string
    assetOwnerCodes: number[]
    operatorCodes: number[]
    operatorNames: number[]
    createDate: string[]
    createUser: string
  }

/**
 * 这个分页类型的Data应该是作为公共interface
 */
  export interface Data {
    pageObject: PageObject[]
    pageIndex: number
    pageSize: number
    totalPage: number
    totalCount: number
  }
  
  export interface PageObject {
    id: string
    vin: string
    vehiclePlate: string
    vehicleType: string
    vehicleModel: string
    assetOwnerName: string
    assetOwnerCode: string
    operatorCode: string
    operatorName: string
    createTime: string
    updateTime: string
    createUser: string
    updateUser: string
  }
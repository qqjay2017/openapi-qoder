// 参考样例（手写）：期望的输出风格示意，不是快照断言，无代码读取它。
// 真正的 emitter 断言在 src/codegen-test.ts。

export interface RootObject {
    userType: string
    bizType: string
    bizLine: string
    bizLineList: number[]
    bizTypeList: number[]
    userId: string
    creditNo: string
    contractNo: string
    productNo: string
    billNo: string
    billType: string
    billStatus: string
    billStatusList: number[]
    lockStatus: string
    billMonth: number[]
    generateDate: string[]
    pushBillTime: string[]
    stationType: string
    cycleType: string
    settleType: string
    carryForwardMethod: string
    carryForwardRange: string
    invoiceStatus: string
    overDueStatus: string
    billEmailSendFlag: string
    billSmsSendFlag: string
    overSmsSendFlag: string
    bizOrderNoList: number[]
    projectCodeList: number[]
    salerCompany: string
    pageIndex: number
    pageSize: number
  }

  
export interface PageObject {
    id: number
    billNo: string
    userId: string
    userName: string
    creditNo: string
    contractNo: string
    projectCode: string
    billMonth: string
    billPeriod: number
    cycleType: string
    billType: string
    settleType: string
    countNum: number
    originAmount: number
    adjustAmount: number
    receivableAmount: number
    payAmount: number
    discountAmount: number
    lastSettleDate: string
    billStatus: string
    generateDate: string
    settleDate: string
    payTime: string
    pushBillTime: string
    pushBillDesc: string
    invoiceStatus: string
    overDueStatus: string
    overDueBillNo: string
    lockStatus: string
    pushBillUserName: string
    carryForwardMethod: string
    billEmailSendFlag: string
    billSmsSendFlag: string
    overSmsSendFlag: string
    overSmsRemindFlag: string
    carryForwardRange: string
    currency: string
    overdueDays: number
    productNo: string
    salerCompanyName: string
    overdueAmount: number
    productName: string
    baseRentAmount: number
    excessMileageFeeAmount: number
  }
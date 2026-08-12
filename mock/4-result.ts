// 参考样例（手写）：期望的输出风格示意，不是快照断言，无代码读取它。
// 真正的 emitter 断言在 src/codegen-test.ts。

export interface RootObject {
    vehiclePlate: string
  }

  export interface Data {
    updateTime: string
    batterySn: string
    vehiclePlate: string
    vin: string
    currentSoc: string
    address: string
  }
# Torna 接口类型生成平台 — 架构设计

> 目标：从 Torna（toena）文档接口生成高质量的 TypeScript 类型 + request 代码，
> 对标 `battery-asset-management-web` 的产物，但解决其两大痛点：
> **类型冗余** 与 **分页类型不可复用/不易提取**。

---

## 1. 设计原则：确定性优先，AI 只做判断题

参考项目 `gen-type.ts` 之所以难用，根因不是「AI 不够聪明」，而是把本该
**结构化、规则化** 的转换写成了「直译」。因此本方案的核心决策是：

- **能用规则做对的，绝不交给 AI**（结构重建、剥壳、分页识别、命名映射的机械部分）。
  这些错误是「静默」的——生成错了类型不会报错，直到运行期才暴露，风险高。
- **AI 只做规则做不好的判断题**（语义命名、枚举归纳、跨文件去重、注释清洗）。
  这些即使 AI 出错也低风险、易人工复核。

所以流程是两段，但**大部分「治理冗余/分页」的工作落在 Stage 1（代码）**，
Stage 2（AI）是锦上添花的润色层。

```
Torna JSON ──▶ Stage 1 确定性 codegen ──▶ 结构正确、已治理的 .ts ──▶ Stage 2 AI 润色 ──▶ 最终产物
              (纯 TS，无 AI，可测试)                              (Qoder Agent SDK)
```

---

## 2. 输入数据模型（Torna doc/view/detail）

平台内部三个接口（见 `接口/` 目录）：

| 接口 | 用途 |
| --- | --- |
| `doc/view/projects` | 空间 → 项目列表（选择要生成的项目） |
| `doc/view/dataByProject?projectId=` | 项目下的接口树（`type:1` 分组 / `type:3` 接口，含 `docId`/`url`/`httpMethod`） |
| `doc/view/detail?id=<docId>` | 单个接口详情（**codegen 的真正输入**） |

`detail` 的关键字段（见 `接口/detail.ts`、`mock/1.json`）：

- `requestParams[]` / `responseParams[]`：**扁平数组**，通过 `id` / `parentId` 关联出树。
  - 顶层字段 `parentId === ""`。
  - 子字段 `parentId === 父字段.id`（例：`mock/1.json` 中 `data.id = XELgbvb8`，
    `pageObject.parentId = XELgbvb8`；`pageObject.id = 2jZMED32`，其下所有列 `parentId = 2jZMED32`）。
- `type`：`string` / `int32` / `int64` / `number` / `boolean` / `object` / `array`。
- `required`：`0/1`（决定是否 `?`）。
- `style`：`2 = 请求参数`，`3 = 响应参数`。
- `description`：字段注释；`"No comments found."` 视为空。
- `enumInfo` / `enumId`：枚举信息（Stage 2 用于提炼枚举常量）。
- `httpMethod`、`url`：生成 request 函数用。

---

## 3. Stage 1 — 确定性 codegen（纯 TypeScript，无 AI）

### 3.1 步骤

1. **拉取 / 读取** `detail` JSON（支持在线拉取或本地 mock）。
2. **重建树**：把 `requestParams` / `responseParams` 从扁平 + `parentId` 还原为嵌套树。
3. **剥响应壳**：识别并**丢弃**统一响应包装
   （`code` / `title` / `msg` / `traceId` / `errorMsg`），
   只保留 `data` 作为业务 VO。—— 对齐 `mock/*-result.ts`（`RootObject`=请求，`Data`=data 载荷）。
   > 包装层由前端 request 拦截器统一处理，类型层不应重复出现。这是「去冗余」第一刀。
4. **分页识别**（治理第二刀，解决「分页不可提取」）：
   当某个对象**同时**含有
   `pageObject|list|records`（数组）+ `totalCount`（+ `pageIndex/pageSize/totalPage` 任意）时，
   判定为分页结构，产出 `PageResult<Item>` 引用**公共类型**，而非内联展开。
   Item 类型单独具名导出。
5. **具名化**：所有嵌套 `object` / `array<object>` 抽为**顶层具名 interface**，
   不再深层内联匿名对象（对齐 mock 产物的 `RootObject` / `Data` / `PageObject`）。
   → 降低嵌套深度、消除重复、item 类型可复用。
6. **类型映射**：`int32/int64/number → number`，`string → string`，
   `boolean → boolean`，`array<T> → T[]`，`object → 具名 interface`。
7. **注释清洗**：`"No comments found."` → 省略；其余 `description` 转 JSDoc。
8. **required 处理**：`required === 0` 的字段加 `?`。

### 3.2 输出结构（每个接口）

```ts
/** 请求参数 —— 来自 requestParams */
export interface XxxParam { ... }

/** 响应 data —— 来自 responseParams 的 data 节点 */
export interface XxxData { ... }        // 或 PageResult<XxxItem>

/** 分页列表项 */
export interface XxxItem { ... }
```

> Stage 1 输出的命名先用**机械命名**（基于 `docName`/`url` 转 PascalCase +
> 后缀 `Param`/`Data`/`Item`），语义命名留给 Stage 2。

---

## 4. 公共类型模块（解决分页复用）

单独一个 `shared/common.ts`，所有生成文件 import：

```ts
/** 统一分页返回体 */
export interface PageResult<T> {
  pageObject: T[];
  pageIndex: number;
  pageSize: number;
  totalPage: number;
  totalCount: number;
}
```

- 字段名以 Torna 实际返回为准（本项目是 `pageObject`；若同时存在 `list`/`records`
  的项目，做别名或配置项）。
- 这正是 `mock/1-result.ts` 注释「这个分页类型的 Data 应该作为公共 interface」的诉求。
- 未来若响应壳需要类型，也放这里：`ApiResponse<T>`（默认不生成，按需开启）。

---

## 5. Stage 2 — AI 润色（Qoder Agent SDK）

集成方式：**`@qoder-ai/qoder-agent-sdk` 的 `query()`**，Node 侧编排，headless 批处理。

### 5.1 AI 只负责

- **语义命名**：`XxxItem → OperationVehicleVO`、`Param` 字段的可读化（结合 `docName`/`description`）。
- **枚举提炼**：从 `enumInfo` 生成 `as const` 常量 + 联合类型（带 `| string` 兼容位）。
- **跨文件去重**：识别结构完全相同的 item 类型，合并到 shared。
- **JSDoc 润色**：把中文描述整理为规范注释。

**AI 不改结构**（嵌套/字段/可选性/分页判定都由 Stage 1 定死），
只做重命名 + 注释 + 枚举，产出必须能通过 `tsc` 校验才接受。

### 5.2 SDK 接入要点（已核对）

```ts
import { query, accessTokenFromEnv } from '@qoder-ai/qoder-agent-sdk';

const q = query({
  prompt: buildPolishPrompt(stage1Output, docMeta),
  options: {
    auth: accessTokenFromEnv(),          // 必须显式传，否则同步抛 AuthNotConfiguredError
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Edit', 'Write'],
    settingSources: [],                  // 服务场景不加载用户/项目环境配置
    maxTurns: 20,                         // 防跑飞
  },
});
try {
  for await (const msg of q) {
    if (msg.type === 'result') {
      if (msg.subtype !== 'success') throw new Error(`polish failed: ${msg.subtype}`);
    }
  }
} finally {
  q.close();                             // 不消费/不关闭会泄漏子进程
}
```

关键陷阱（来自 SDK 指南）：
- 运行失败以 `result.subtype`（`error_*`）返回，**不是抛异常**；抛异常=进程没起来（auth/binary）。
- 需要 `QODER_PERSONAL_ACCESS_TOKEN` 环境变量。
- 可选：用 `createSdkMcpServer` 提供 `tsc 校验` 工具，让 AI 自检类型是否编译通过后再交付。

### 5.3 校验闭环

Stage 2 产物 → `tsc --noEmit` → 失败则回退到 Stage 1 机械命名版本（保证「至少正确」）。

---

## 6. 建议目录结构（本平台代码）

```
openapi-qoder/
├─ src/
│  ├─ torna/            # 三个接口的 client（projects / dataByProject / detail）
│  ├─ codegen/          # Stage 1：纯 TS
│  │   ├─ tree.ts       # id/parentId 树重建
│  │   ├─ envelope.ts   # 响应壳剥离
│  │   ├─ pagination.ts # 分页识别 → PageResult<T>
│  │   ├─ emit.ts       # 具名 interface 输出
│  │   └─ naming.ts     # 机械命名
│  ├─ polish/           # Stage 2：Qoder SDK 编排 + prompt + tsc 校验
│  └─ shared/common.ts  # PageResult<T> 等公共类型（随产物一起分发）
├─ 接口/                # Torna 内部接口样本（现有）
├─ mock/                # 4 个用例：*.json 输入 + *-result.ts 期望产物（现有）
└─ ARCHITECTURE.md
```

---

## 7. 命名规则（初版）

| 项 | 规则 |
| --- | --- |
| 请求参数 | `<PascalName>Param`（Stage2 → 语义化如 `HostingVehiclePageParam`） |
| 响应 data | `<PascalName>Data` 或 `PageResult<<PascalName>Item>` |
| 列表项 | `<PascalName>Item`（Stage2 → `<Domain>VO`） |
| 枚举 | `UPPER_SNAKE` 常量 + `PascalCase` 类型 |
| PascalName 来源 | 优先 `url` 末段 → 回退 `docName` 转拼音/英文 |

---

## 8. 输出格式取舍

不采用参考项目的 `paths` 大接口内联风格（正是冗余来源），
改为**每接口一组具名 interface**（对齐 `mock/*-result.ts`）。
可选再导出一层便捷别名（`export type XxxReq = XxxParam`）供页面直接引用。

---

## 9. 验收：4 个 mock 用例

Stage 1 产物必须与 `mock/*-result.ts` 结构一致：

| 用例 | 重点验证 |
| --- | --- |
| `1` 托管运营车辆分页列表 | 分页识别 → `PageResult<PageObject>` + 请求 `RootObject` |
| `2` | 简单对象 data |
| `3` | 请求多字段 + data 单字段 |
| `4` 车辆信息 | 扁平 data、剥壳后仅保留业务字段 |

以 `-result.ts` 为 golden file 做快照测试。

---

## 10. 风险 / 待确认

1. **分页字段名跨项目是否统一**（`pageObject` vs `list` vs `records`）——需配置化。
2. **响应壳字段清单**是否所有项目一致（`code/title/msg/traceId/errorMsg`）。
3. **Torna 鉴权**：`token` 会过期（见 `接口/*.ts` header），在线拉取需 token 管理。
4. **AI 命名一致性**：同一 domain 多接口应命名协调 —— 可按 project 批量喂给 SDK 保持上下文。

---

## 11. 里程碑

1. **M1** Stage 1 codegen 打通，4 个 mock 用例快照通过（无 AI，可离线跑）。
2. **M2** Torna client + 批量拉取 → 对整个 project 生成。
3. **M3** Stage 2 Qoder SDK 润色层 + `tsc` 校验闭环。
4. **M4** 命名账本（可重入/增量）+ CLI 平台化封装。

---

## 12. 命名账本（M4）—— 让 AI 润色可重入

### 问题

AI 润色**不确定**。第二次跑会重新命名，导致：
- 名字漂移 → 页面里 `import { getHostingVehiclePage }` 全部失效；
- diff 噪音巨大，无法 review；
- 每次都全量调用 AI，成本随接口总数增长。

### 方案：决策与产物分离

把 AI 的每个决策落盘到 `.openapi-qoder/naming.lock.json`（**提交进 git**），
生成文件只是产物。

```jsonc
{
  "version": 1,
  "apis": {
    "nzDyBg12": {                     // Torna docId = 稳定身份
      "url": "/2m/v1.0/hostingVehicle/page",
      "httpMethod": "POST",
      "shape": "a1b2c3d4e5f6",        // 结构指纹，决定是否需要重新润色
      "fn": "getHostingVehiclePage",
      "locked": true,                 // 函数名冻结，消费方按名 import
      "types": {                      // 机械名 -> 语义名
        "HostingVehiclePageParam": "HostingVehicleQueryParam",
        "HostingVehiclePageItem": "HostingVehicleVO"
      },
      "fieldTypes": {                 // 标量数组元素推断
        "HostingVehiclePageParam.operatorNames": "string[]"
      },
      "source": "ai"                  // "manual" = 人工命名，AI 永不覆盖
    }
  }
}
```

### 三段式流水线

| 阶段 | 是否用 AI | 作用 |
| --- | --- | --- |
| Stage 1 | ❌ | 确定性生成，机械命名 + `shape` 指纹写入文件头 |
| **Stage 1.5 apply** | ❌ | 按账本把机械名替换为既有决策（纯文本替换） |
| Stage 2 polish | ✅ | **只处理账本缺失/失效的部分** |

### 增量判定

- `shape` 未变 + 账本命中 → **完全跳过 AI**，纯代码复用旧名，零漂移零成本。
- 文档更新导致 `shape` 变化 → 沿用仍存在的机械名映射，只把新增字段/新类型交给 AI。
- 字段被文档删除 → 账本条目成为 orphan，可告警/清理。

### 两个保障

- **`locked: true`**：函数名一旦定名即冻结（消费方直接 import）。
- **`source: "manual"`**：人工手调命名优先级最高，`harvest` 会跳过、AI 不覆盖。

### harvest（引导账本）

`harvest` 通过**逐声明配对** Stage-1 与 Stage-2 文件来反推决策：
因 Stage-2 被硬约束禁止增删/重排声明与属性，按序号配对是可靠的。
一旦结构不匹配（说明 AI 违约），该文件**拒绝入账**而非记录错误映射。

---

## 13. CLI（M4）

```bash
qgen list                 # 列出空间/项目
qgen pick                 # 交互式：空间 → 项目 → 生成
qgen gen <projectId>      # 拉取 + Stage-1 + 复用账本(Stage-1.5)
qgen harvest <projectId>  # 把 Stage-2 结果记入账本
qgen status <projectId>   # 查看 in-ledger / shape 变更 / 未解析 unknown[]

npx tsx src/polish-run.ts <projectId>   # Stage-2 AI 润色（产物在 generated/ 下）
npm test                                # emitter + 账本往返自测
```

`qgen gen` 不会覆盖尚未 harvest 的 Stage-2 文件（识别 Stage-2 头注释）。
确认已入账本后可用 `qgen gen <pid> --force` 强制重写。

典型工作流：

```
qgen gen <pid>  ->  polish-run  ->  qgen harvest <pid>  ->  提交 naming.lock.json
# 文档更新后再次：
qgen gen <pid>   # 大部分接口直接复用账本，只剩少数需要 polish
```

# Torna 接口类型生成平台 — 架构设计

> 目标：从 Torna（toena）文档接口生成高质量的 TypeScript 类型 + request 代码，
> 对标 `battery-asset-management-web` 的产物，但解决其两大痛点：
> **类型冗余** 与 **分页类型不可复用/不易提取**。

---

## 1. 设计原则：确定性契约 + 受约束的 AI 重构

参考项目 `gen-type.ts` 之所以难用，根因不是「AI 不够聪明」，而是把本该确定的协议转换交给了自由生成。因此流水线明确分工：

- **Stage 1 固定 wire contract**：负责树重建、响应剥壳、分页识别、字段类型/可选性、枚举值、URL 和 HTTP 方法，结果可离线测试。
- **Stage 2 优化 TypeScript 表达**：结合接口语义做命名、数组元素推断、注释整理，也可抽公共接口、使用 `extends`、`Pick`/`Omit`、别名或适度泛型消除重复。
- **验证器守住边界**：Stage 2 输出必须通过 AST 契约等价检查和 `tsc`；属性、可选性、已知类型、枚举值、分页包装或请求运行时代码发生变化时整文件回滚。

```
Torna JSON ──▶ Stage 1 确定性 codegen ──▶ Stage 2 AI 类型重构 ──▶ AST 契约校验 ──▶ tsc ──▶ 最终产物
              （定义协议事实）          （优化表达与复用）       （拒绝语义漂移）
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

## 5. Stage 2 — 受约束的 AI 类型重构（Qoder Agent SDK）

集成方式：**`@qoder-ai/qoder-agent-sdk` 的 `query()`**，Node 侧编排，headless 批处理；VS Code 扩展使用同一份 Prompt 通过 Cloud Agents 文本接口执行。

### 5.1 AI 可以优化

- **类型复用**：识别查询/导出、提交/草稿、多校验接口中的公共字段，抽取业务语义明确的基类并通过 `extends` 复用。
- **组合表达**：在更清晰时使用 `Pick`、`Omit`、别名或适度泛型；禁止无收益的复杂条件类型和映射类型。
- **语义命名**：统一接口、别名、枚举和请求函数的领域命名。
- **类型收窄与注释**：根据上下文收窄 `unknown[]`，整理中文 JSDoc。

规则提炼自 [typescript-advanced-types](https://github.com/wshobson/agents/tree/main/plugins/javascript-typescript/skills/typescript-advanced-types) 与 [typescript-best-practices](https://github.com/cursor/plugins/blob/main/pstack/skills/typescript-best-practices/SKILL.md)，直接进入共享 Prompt，而不是运行时加载第三方 Skill。原因是本地 SDK 使用 `settingSources: []`，云端 Agent 又没有文件工具；Prompt 内置可以保证两条链路行为一致、离线可用并避免远端内容漂移。

### 5.2 不可改变的边界

- 每个接口的属性键、可选性、只读性、已知字段类型、枚举值、分页包装必须保持不变。
- 请求 URL、HTTP 方法、函数参数传递和 request 调用等运行时代码必须保持不变。
- 每个原始请求/响应角色都必须保留一个对应导出；允许语义重命名、改成 `extends` 或别名，但不能把两个操作级角色压成一个导出。
- 禁止新增 `any`、类型断言、非空断言或运行时代码。

### 5.3 SDK 接入要点

```ts
import { query, accessTokenFromEnv } from '@qoder-ai/qoder-agent-sdk';

const q = query({
  prompt: buildPolishPrompt(stage1Output, docMeta),
  options: {
    auth: accessTokenFromEnv(),          // 必须显式传，否则同步抛 AuthNotConfiguredError
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Edit'],
    settingSources: [],                  // 规则已内置到 Prompt，不加载环境配置
    maxTurns: 60,                         // 可通过 POLISH_MAX_TURNS 调整
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

### 5.4 校验闭环

Stage 2 产物先由 `src/polish/validate.ts` 展开 interface 继承、别名、泛型、`Pick`/`Omit` 和枚举，按请求端点比较润色前后的有效契约与运行时调用；通过后再执行 `tsc --noEmit`。任一步失败都回退到本轮输入版本。

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
4. **M4** 润色账本与产物快照（可重入/增量）+ CLI 平台化封装。

---

## 12. 润色账本与快照（M4）—— 让 AI 重构可重入

### 问题

AI 润色具有不确定性，类型结构优化又会新增基类、调整继承和重排声明。若每次都从 Stage-1 重新开始，会造成命名与抽象漂移、重复消耗模型额度，并使旧的“按声明序号反推改名”无法完整重放。

### 方案：轻量决策 + 已验证产物快照

- `.openapi-qoder/naming.lock.json` 继续记录机械名到语义名、函数名和 `unknown[]` 收窄，兼容旧账本。
- 结构优化后的完整文件保存到 `.openapi-qoder/polished/<docId>-<baseHash>.ts`；账本只记录 Stage-1 哈希、快照内容哈希和文件名。
- 快照写入前必须通过 AST 契约校验；读取时校验内容哈希，且只允许从固定的 `polished` 目录读取。

```jsonc
{
  "version": 1,
  "apis": {
    "nzDyBg12": {
      "url": "/2m/v1.0/hostingVehicle/page",
      "httpMethod": "POST",
      "kind": "api",
      "shape": "a1b2c3d4e5f6",
      "types": { "HostingVehiclePageItem": "HostingVehicleVO" },
      "fns": {
        "nzDyBg12": {
          "mechanical": "hostingVehiclePage",
          "semantic": "getHostingVehiclePage",
          "locked": true
        }
      },
      "fieldTypes": { "HostingVehiclePageParam.operatorNames": "string[]" },
      "polishArtifact": {
        "baseHash": "7c8d...",
        "contentHash": "0e91...",
        "file": "nzDyBg12-7c8d....ts"
      },
      "source": "ai"
    }
  }
}
```

### 三段式流水线

| 阶段 | 是否用 AI | 作用 |
| --- | --- | --- |
| Stage 1 | ❌ | 确定性生成原始协议类型与 `shape` |
| **Stage 1.5 replay** | ❌ | Stage-1 内容哈希匹配时精确恢复已验证快照；否则仅回放安全的旧命名 |
| Stage 2 polish | ✅ | 基于当前 Stage-1 优化类型；有旧快照时把其类型设计作为参考 |

### 多次运行策略

- **Stage-1 内容完全一致**：直接恢复旧快照并跳过 AI，输出字节稳定。
- **文档或生成配置变化**：旧快照不能覆盖新协议；系统提取上一版的类型声明（不携带运行时代码和长注释）作为上下文，让 AI 保留仍适用的命名和抽象，在新 Stage-1 上增量调整。
- **未 harvest 的 Stage-2 文件**：继续保留，不被生成命令覆盖。
- **人工条目**：`source: "manual"` 时自动 harvest 不覆盖。

### harvest

`harvest` 不再要求声明数量和顺序完全相同。它先执行与在线流程相同的 AST 契约校验；合法的结构重构保存为快照，简单重命名仍同步提取为轻量决策，以便 shape 变化时安全沿用。

---

## 13. CLI（M4）

```bash
qgen list                 # 列出空间/项目
qgen pick                 # 交互式：空间 → 项目 → 生成
qgen gen <projectId>      # 拉取 + Stage-1 + 重放已验证润色结果
qgen harvest <projectId>  # 校验并保存 Stage-2 决策与快照
qgen status <projectId>   # 查看 in-ledger / shape 变更 / 未解析 unknown[]

npx tsx src/polish-run.ts <projectId>   # Stage-2 AI 类型重构与润色
npm test                                # emitter + 账本 + 契约校验自测
```

`qgen gen` 不会覆盖尚未 harvest 的 Stage-2 文件；已有账本时则按 Stage-1 哈希恢复快照，或在文档变化后生成新的待润色版本。

典型工作流：

```
qgen gen <pid>  ->  polish-run  ->  qgen harvest <pid>
# 提交 naming.lock.json 与 .openapi-qoder/polished/
# 文档更新后再次：
qgen gen <pid>   # 未变化文件精确重放，变化文件在下次 polish 时引用旧类型设计
```

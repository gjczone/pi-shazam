# Pi ExtensionAPI 真实契约

> 提取自 `@earendil-works/pi-coding-agent@0.78.1` 运行时源码。
> 此文档覆盖与 pi-shazam 相关的所有 API 契约。类型桩 `types/pi-extension.d.ts` 以此为准。

## 扩展工厂函数

```ts
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

**`pi` 对象是扁平纯对象，无嵌套的 `logger`、`typebox`、`zod`、`pi` 属性。**

---

## ExtensionAPI 属性（扩展可用）

| 属性                          | 类型     | 说明              |
| ----------------------------- | -------- | ----------------- |
| `on(event, handler)`          | 事件注册 | 订阅生命周期事件  |
| `registerTool(tool)`          | 工具注册 | 注册 LLM 可见工具 |
| `registerCommand(name, opts)` | 命令注册 | 注册 `/command`   |
| `sendMessage(msg, opts?)`     | 发消息   | 发送自定义消息    |
| `events`                      | EventBus | 扩展间通信        |

（完整列表见 loader.js `createExtensionAPI()`，以上是 pi-shazam 使用的）

---

## `sendMessage` 契约

```ts
sendMessage(message: {
  customType: string;
  content: string | (TextContent | ImageContent)[];  // 两者均可
  display: boolean;
  details?: unknown;
}, options?: {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}): void;
```

**内部处理**：

- 构造 `{ role: "custom", customType, content, display, details, timestamp }` 消息
- 不修改 content，原样传递
- 转为 LLM 消息时：string → `[{type:"text", text}]`；数组 → 原样使用

**pi-shazam 用法**：全部使用 `string` 格式 ✅

---

## `before_agent_start` 返回值

```ts
interface BeforeAgentStartEventResult {
	message?: {
		customType: string;
		content: string | (TextContent | ImageContent)[];
		display: boolean;
		details?: unknown;
	};
	systemPrompt?: string; // ← 单个 string，非 string[]
}
```

**链式覆盖**：多个扩展 handler 依次执行，最后一个返回 `systemPrompt` 的扩展决定最终值。

**pi-shazam 用法**：返回 `{ systemPrompt: overviewText }`（string）✅

---

## `tool_result` 返回值

```ts
interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[]; // 数组
	details?: unknown;
	isError?: boolean;
}
```

**pi-shazam 用法**：不返回值，通过 `sendMessage` 发送结果 ✅

---

## `registerTool` 契约

```ts
interface ToolDefinition<TParams, TDetails> {
	name: string;
	label: string;
	description: string;
	parameters: TParams; // TypeBox schema（直接从 typebox 包 import）
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext, // ← 第 5 个参数
	): Promise<AgentToolResult<TDetails>>;
}
```

**`AgentToolResult`**：

```ts
interface AgentToolResult<T> {
	content: (TextContent | ImageContent)[]; // 始终是数组
	details?: T;
	isError?: boolean;
}
```

**pi-shazam 用法**：全部返回 `{ content: [{ type: "text", text: string }] }` ✅

---

## 参数 schema

**TypeBox 必须直接从 `typebox` 包 import**，不使用 `pi.typebox`（运行时不存在）。

```ts
import { Type } from "typebox"; // 扩展可用 jiti 解析此模块
```

**pi-shazam 用法**：全部使用 `import { Type } from "typebox"` ✅

---

## pi-shazam 不得依赖的属性（运行时不存在）

| 属性         | 状态                         |
| ------------ | ---------------------------- |
| `pi.logger`  | ❌ 不存在（已用 `?.` 防御）  |
| `pi.typebox` | ❌ 不存在（已用直接 import） |
| `pi.zod`     | ❌ 不存在（不使用）          |
| `pi.pi`      | ❌ 不存在（不使用）          |

---

## 验证清单

在每次修改后执行：

```
□ npm run typecheck          # 零错误
□ npm test                   # 全部通过
□ npm run build              # 编译成功
□ grep "pi.logger\." dist/   # 无直接调用（只有 ?. 可选链）
□ grep "pi.typebox" dist/    # 无引用
□ grep "content:" dist/tools/*.js  # 全部是数组格式 [{type:"text", text:...}]
□ grep "content:" dist/index.js dist/hooks/*.js  # 全部是字符串格式
□ grep "systemPrompt:" dist/hooks/*.js  # 返回 string，非 string[]
```

---

## 修改记录

| 版本 | 日期       | 变更                                    |
| ---- | ---------- | --------------------------------------- |
| 1.0  | 2026-06-05 | 初始版本，提取自 pi-coding-agent@0.78.1 |

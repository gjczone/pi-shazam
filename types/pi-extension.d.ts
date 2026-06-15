/**
 * Pi Extension API type definitions (self-contained stub)
 *
 * Type stubs extracted from @oh-my-pi/pi-coding-agent@15.8.0.
 * External types from @oh-my-pi/pi-* use minimal stubs (method signatures preserved, concrete implementation types replaced with any).
 * Types from relative-path imports (../../...) are inlined or stubbed.
 * ExtensionAPI method signatures are preserved unchanged.
 *
 * Usage: import type { ExtensionAPI } from "./types/pi-extension"
 */

// ---------------------------------------------------------------------------
// External stubs: @oh-my-pi/pi-agent-core
// ---------------------------------------------------------------------------

/** Agent message (union type of user / assistant / toolResult roles) */
export type AgentMessage = any;

/** Agent tool execution result */
export interface AgentToolResult<TDetails = unknown> {
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	isError?: boolean;
}

/** Agent tool incremental update callback during execution */
export type AgentToolUpdateCallback<TDetails = unknown> = (update: Partial<AgentToolResult<TDetails>>) => void;

/** Thinking level (extended thinking control) */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// External stubs: @oh-my-pi/pi-agent-core/compaction
// ---------------------------------------------------------------------------

/** Context compaction result */
export interface CompactionResult {
	summary: string;
	details?: unknown;
}

/** Context compaction preparation data */
export interface CompactionPreparation {
	messages: AgentMessage[];
	[key: string]: any;
}

// ---------------------------------------------------------------------------
// External stubs: @oh-my-pi/pi-ai
// ---------------------------------------------------------------------------

/** API type identifier */
export type Api = string;

/** Assistant message stream event */
export type AssistantMessageEvent = any;

/** Assistant message event stream */
export type AssistantMessageEventStream = any;

/** LLM context object */
export type Context = any;

/** Image content block */
export interface ImageContent {
	type: "image";
	source: {
		type: "base64";
		media_type: string;
		data: string;
	};
}

/** 文本内容块 */
export interface TextContent {
	type: "text";
	text: string;
}

/** 模型配置 */
export interface Model<TApi extends Api = Api> {
	id: string;
	name: string;
	api?: TApi;
	reasoning?: boolean;
	thinking?: {
		mode?: string;
		minLevel?: ThinkingLevel;
		maxLevel?: ThinkingLevel;
		[key: string]: any;
	};
	input?: ("text" | "image")[];
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow?: number;
	maxTokens?: number;
	compat?: any;
	[key: string]: any;
}

/** Provider 响应元数据 */
export interface ProviderResponseMetadata {
	type?: string;
	[key: string]: any;
}

/** 简单流选项 */
export interface SimpleStreamOptions {
	signal?: AbortSignal;
	[key: string]: any;
}

/** 从 schema 推导静态类型（TypeBox/Zod 通用） */
export type Static<T> = T extends { _type: infer U } ? U : any;

/** Schema 基类（TypeBox/Zod 通用） */
export type TSchema = any;

/** 消息归属（billing/attribution 语义） */
export interface MessageAttribution {
	type?: string;
	[key: string]: any;
}

/** 工具结果消息 */
export type ToolResultMessage = any;

// ---------------------------------------------------------------------------
// External stubs: @oh-my-pi/pi-ai/utils/oauth/types
// ---------------------------------------------------------------------------

/** OAuth 凭据 */
export interface OAuthCredentials {
	[key: string]: any;
}

/** OAuth 登录回调 */
export interface OAuthLoginCallbacks {
	[key: string]: any;
}

// ---------------------------------------------------------------------------
// External stubs: @oh-my-pi/pi-tui
// ---------------------------------------------------------------------------

/** 自动补全项 */
export interface AutocompleteItem {
	label: string;
	description?: string;
	[key: string]: any;
}

/** TUI 组件基类 */
export type Component = any;

/** 编辑器主题 */
export type EditorTheme = any;

/** 键盘按键 ID */
export type KeyId = string;

/** TUI 实例 */
export type TUI = any;

// ---------------------------------------------------------------------------
// External stubs: @oh-my-pi/pi-utils
// ---------------------------------------------------------------------------

/** 文件日志记录器 */
export interface PiLogger {
	debug(...args: any[]): void;
	info(...args: any[]): void;
	warn(...args: any[]): void;
	error(...args: any[]): void;
	[key: string]: any;
}

// ---------------------------------------------------------------------------
// External stubs: @oh-my-pi/pi-coding-agent (整个模块)
// ---------------------------------------------------------------------------

/** pi-coding-agent SDK 导出 */
export type PiCodingAgent = any;

// ---------------------------------------------------------------------------
// External stubs: zod/v4
// ---------------------------------------------------------------------------

/** Zod 模块 */
export type ZodModule = any;

// ---------------------------------------------------------------------------
// External stubs: ../typebox
// ---------------------------------------------------------------------------

/** TypeBox 模块（Zod 兼容 shim，用于 Type.Object(...) 参数定义） */
export type TypeBoxModule = any;

// ---------------------------------------------------------------------------
// Relative path stubs: config/keybindings
// ---------------------------------------------------------------------------

/** 快捷键管理器 */
export interface KeybindingsManager {
	[key: string]: any;
}

/** 应用快捷键定义 */
export interface AppKeybinding {
	[key: string]: any;
}

// ---------------------------------------------------------------------------
// Relative path stubs: config/model-registry
// ---------------------------------------------------------------------------

/** 模型注册表（API key 解析） */
export interface ModelRegistry {
	[key: string]: any;
}

// ---------------------------------------------------------------------------
// Relative path stubs: session/session-manager
// ---------------------------------------------------------------------------

/** 只读会话管理器 */
export interface ReadonlySessionManager {
	[key: string]: any;
}

/** 会话管理器（可写） */
export interface SessionManager {
	[key: string]: any;
}

/** 会话条目 */
export type SessionEntry = any;

/** 分支摘要条目 */
export type BranchSummaryEntry = any;

/** 压缩条目 */
export type CompactionEntry = any;

// ---------------------------------------------------------------------------
// Relative path stubs: modes/theme/theme
// ---------------------------------------------------------------------------

/** 主题对象 */
export type Theme = any;

// ---------------------------------------------------------------------------
// Relative path stubs: modes/components/custom-editor
// ---------------------------------------------------------------------------

/** 自定义编辑器组件 */
export type CustomEditor = any;

// ---------------------------------------------------------------------------
// Relative path stubs: session/messages
// ---------------------------------------------------------------------------

/**
 * 扩展注入的自定义消息
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** 消息归属（billing/attribution 语义） */
	attribution?: MessageAttribution;
	timestamp: number;
}

// ---------------------------------------------------------------------------
// Relative path stubs: exec/exec
// ---------------------------------------------------------------------------

/** 执行 shell 命令的选项 */
export interface ExecOptions {
	/** 取消信号的 AbortSignal */
	signal?: AbortSignal;
	/** 超时时间（毫秒） */
	timeout?: number;
	/** 工作目录 */
	cwd?: string;
}

/** 执行 shell 命令的结果 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

// ---------------------------------------------------------------------------
// Relative path stubs: exec/bash-executor
// ---------------------------------------------------------------------------

/** Bash 执行结果 */
export type BashResult = any;

// ---------------------------------------------------------------------------
// Relative path stubs: eval/py/executor
// ---------------------------------------------------------------------------

/** Python 执行结果 */
export type PythonResult = any;

// ---------------------------------------------------------------------------
// Relative path stubs: edit
// ---------------------------------------------------------------------------

/** 编辑工具详情 */
export interface EditToolDetails {
	/** 变更的统一 diff */
	diff: string;
	/** 新文件中第一个变更行号（用于编辑器导航） */
	firstChangedLine?: number;
	/** 诊断结果 */
	diagnostics?: any;
	/** 操作类型 */
	op?: any;
	/** 移动/重命名后的新路径 */
	move?: string;
	/** 结构化输出元数据 */
	meta?: any;
	/** 每文件结果（多文件编辑） */
	perFileResults?: any[];
	/** 单文件编辑的绝对路径 */
	path?: string;
	/** 编辑前的源内容 */
	oldText?: string;
	/** 编辑后的源内容 */
	newText?: string;
}

// ---------------------------------------------------------------------------
// Relative path stubs: tools (input / details 类型)
// ---------------------------------------------------------------------------

/** Bash 工具输入参数 */
export interface BashToolInput {
	command: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	async?: boolean;
	pty?: boolean;
}

/** Bash 工具详情 */
export interface BashToolDetails {
	meta?: any;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	wallTimeMs?: number;
	exitCode?: number;
	terminalId?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
	};
}

/** 读取工具输入参数 */
export interface ReadToolInput {
	path: string;
}

/** 读取工具详情 */
export interface ReadToolDetails {
	kind?: "file" | "url";
	truncation?: any;
	isDirectory?: boolean;
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: any;
	displayContent?: { text: string; startLine: number };
	summary?: { lines: number; elidedSpans: number; elidedLines: number };
	conflictCount?: number;
}

/** 搜索工具输入参数 */
export interface SearchToolInput {
	pattern: string;
	paths: string | string[];
	i?: boolean;
	gitignore?: boolean;
	skip?: number;
}

/** 搜索工具详情 */
export interface SearchToolDetails {
	truncation?: any;
	fileLimitReached?: number;
	perFileLimitReached?: number;
	linesTruncated?: boolean;
	meta?: any;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	truncated?: boolean;
	error?: string;
	displayContent?: string;
	searchPath?: string;
	missingPaths?: string[];
}

/** 查找工具输入参数 */
export interface FindToolInput {
	paths: string[];
	hidden?: boolean;
	gitignore?: boolean;
	limit?: number;
	timeout?: number;
}

/** 查找工具详情 */
export interface FindToolDetails {
	truncation?: any;
	resultLimitReached?: number;
	meta?: any;
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	cwd?: string;
	missingPaths?: string[];
}

/** 写入工具输入参数 */
export interface WriteToolInput {
	path: string;
	content: string;
}

// ---------------------------------------------------------------------------
// Relative path stubs: utils/event-bus
// ---------------------------------------------------------------------------

/** 事件总线（扩展间通信） */
export declare class EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
	clear(): void;
}

// ---------------------------------------------------------------------------
// Relative path stubs: slash-commands
// ---------------------------------------------------------------------------

/** 斜杠命令来源 */
export type SlashCommandSource = "extension" | "prompt" | "skill";

/** 斜杠命令位置 */
export type SlashCommandLocation = "user" | "project" | "path";

/** 斜杠命令信息 */
export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	location?: SlashCommandLocation;
	path?: string;
}

// ---------------------------------------------------------------------------
// Relative path stubs: capability/rule, goals/state, tools/todo-write
// ---------------------------------------------------------------------------

/** TTSR 规则 */
export type Rule = any;

/** 目标定义 */
export type Goal = any;

/** 目标模式状态 */
export type GoalModeState = any;

/** Todo 项 */
export interface TodoItem {
	id: string;
	description: string;
	status: string;
	[key: string]: any;
}

// ---------------------------------------------------------------------------
// Shared events (from ../shared-events)
// ---------------------------------------------------------------------------

/** 会话启动事件 */
export interface SessionStartEvent {
	type: "session_start";
}

/** 会话切换前事件（可取消） */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume" | "fork";
	targetSessionFile?: string;
}

/** 会话切换后事件 */
export interface SessionSwitchEvent {
	type: "session_switch";
	reason: "new" | "resume" | "fork";
	previousSessionFile: string | undefined;
}

/** 会话分支前事件（可取消） */
export interface SessionBeforeBranchEvent {
	type: "session_before_branch";
	entryId: string;
}

/** 会话分支后事件 */
export interface SessionBranchEvent {
	type: "session_branch";
	previousSessionFile: string | undefined;
}

/** 上下文压缩前事件（可取消或自定义） */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	signal: AbortSignal;
}

/** 压缩中事件（可自定义 prompt/context） */
export interface SessionCompactingEvent {
	type: "session.compacting";
	sessionId: string;
	messages: AgentMessage[];
}

/** 上下文压缩后事件 */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
}

/** 进程退出事件 */
export interface SessionShutdownEvent {
	type: "session_shutdown";
}

/** 树导航准备数据 */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
}

/** 会话树导航前事件（可取消） */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** 会话树导航后事件 */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

/** 目标更新事件 */
export interface GoalUpdatedEvent {
	type: "goal_updated";
	goal: Goal | null;
	state?: GoalModeState;
}

/** 会话事件联合类型 */
export type SessionEvent =
	| SessionStartEvent
	| SessionBeforeSwitchEvent
	| SessionSwitchEvent
	| SessionBeforeBranchEvent
	| SessionBranchEvent
	| SessionBeforeCompactEvent
	| SessionCompactingEvent
	| SessionCompactEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent
	| GoalUpdatedEvent;

/** 上下文事件（每次 LLM 调用前触发） */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/** Agent 循环开始事件 */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Agent 循环结束事件 */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

/** Turn 开始事件 */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** Turn 结束事件 */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

/** 自动压缩开始事件 */
export interface AutoCompactionStartEvent {
	type: "auto_compaction_start";
	reason: "threshold" | "overflow" | "idle" | "incomplete";
	action: "context-full" | "handoff" | "shake";
}

/** 自动压缩结束事件 */
export interface AutoCompactionEndEvent {
	type: "auto_compaction_end";
	action: "context-full" | "handoff" | "shake";
	result: CompactionResult | undefined;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
	skipped?: boolean;
}

/** 自动重试开始事件 */
export interface AutoRetryStartEvent {
	type: "auto_retry_start";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

/** 自动重试结束事件 */
export interface AutoRetryEndEvent {
	type: "auto_retry_end";
	success: boolean;
	attempt: number;
	finalError?: string;
}

/** TTSR 规则触发事件 */
export interface TtsrTriggeredEvent {
	type: "ttsr_triggered";
	rules: Rule[];
}

/** Todo 提醒事件 */
export interface TodoReminderEvent {
	type: "todo_reminder";
	todos: TodoItem[];
	attempt: number;
	maxAttempts: number;
}

/** tool_call 处理结果 */
export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
}

/** tool_result 处理结果 */
export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

/** session_before_switch 处理结果 */
export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

/** session_before_branch 处理结果 */
export interface SessionBeforeBranchResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

/** session_before_compact 处理结果 */
export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

/** session.compacting 处理结果 */
export interface SessionCompactingResult {
	context?: string[];
	prompt?: string;
	preserveData?: Record<string, unknown>;
}

/** session_before_tree 处理结果 */
export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
	};
}

// ---------------------------------------------------------------------------
// Extension-specific types (from types.d.ts)
// ---------------------------------------------------------------------------

/** UI 选择器选项 */
export interface ExtensionUISelectOption {
	label: string;
	description?: string;
}

/** UI 选择器项目（字符串或选项对象） */
export type ExtensionUISelectItem = string | ExtensionUISelectOption;

/** UI 对话框选项 */
export interface ExtensionUIDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
	onTimeout?: () => void;
	initialIndex?: number;
	outline?: boolean;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
}

/** 原始终端输入处理器 */
export type TerminalInputHandler = (data: string) =>
	| {
			consume?: boolean;
			data?: string;
	  }
	| undefined;

/** Widget 放置位置 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Widget 选项 */
export interface ExtensionWidgetOptions {
	placement?: WidgetPlacement;
}

/** 扩展 UI 组件（可销毁） */
export type ExtensionUiComponent = Component & {
	dispose?(): void;
};

/** 扩展 UI 组件工厂 */
export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;

/** Widget 内容 */
export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

/**
 * 扩展 UI 上下文 —— 提供交互式 UI 请求方法。
 * 每种模式（interactive, RPC, print）提供自己的实现。
 */
export interface ExtensionUIContext {
	/** 显示选择器并返回选中的 label */
	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;
	/** 显示确认对话框 */
	confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean>;
	/** 显示文本输入对话框 */
	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>;
	/** 显示通知 */
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** 监听原始终端输入（仅 interactive 模式），返回取消订阅函数 */
	onTerminalInput(handler: TerminalInputHandler): () => void;
	/** 设置底部状态栏文本，传 undefined 清除 */
	setStatus(key: string, text: string | undefined): void;
	/** 设置 streaming 时的工作消息 */
	setWorkingMessage(message?: string): void;
	/** 设置编辑器上/下方的 widget */
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
	/** 设置自定义 footer 组件 */
	setFooter(factory: ExtensionUiComponentFactory | undefined): void;
	/** 设置自定义 header 组件 */
	setHeader(factory: ExtensionUiComponentFactory | undefined): void;
	/** 设置终端窗口/标签标题 */
	setTitle(title: string): void;
	/** 显示自定义组件并获取键盘焦点 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		options?: {
			overlay?: boolean;
		},
	): Promise<T>;
	/** 设置核心输入编辑器的文本 */
	setEditorText(text: string): void;
	/** 粘贴文本到核心输入编辑器 */
	pasteToEditor(text: string): void;
	/** 获取核心输入编辑器的当前文本 */
	getEditorText(): string;
	/** 显示多行编辑器 */
	editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: {
			promptStyle?: boolean;
		},
	): Promise<string | undefined>;
	/** 设置自定义编辑器组件 */
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void;
	/** 获取当前主题 */
	readonly theme: Theme;
	/** 获取所有可用主题 */
	getAllThemes(): Promise<{ name: string; path: string | undefined }[]>;
	/** 按名称加载主题（不切换） */
	getTheme(name: string): Promise<Theme | undefined>;
	/** 按名称或 Theme 对象设置主题 */
	setTheme(theme: string | Theme): Promise<{ success: boolean; error?: string }>;
	/** 获取当前工具输出展开状态 */
	getToolsExpanded(): boolean;
	/** 设置工具输出展开状态 */
	setToolsExpanded(expanded: boolean): void;
}

/** 上下文使用量 */
export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** 压缩选项 */
export interface CompactOptions {
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * 扩展事件处理器的上下文
 */
export interface ExtensionContext {
	/** UI 交互方法 */
	ui: ExtensionUIContext;
	/** 获取当前模型的上下文使用量 */
	getContextUsage(): ContextUsage | undefined;
	/** 压缩会话上下文 */
	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
	/** UI 是否可用（print/RPC 模式下为 false） */
	hasUI: boolean;
	/** 当前工作目录 */
	cwd: string;
	/** 只读会话管理器 */
	sessionManager: ReadonlySessionManager;
	/** 模型注册表（API key 解析） */
	modelRegistry: ModelRegistry;
	/** 当前模型 */
	model: Model | undefined;
	/** Agent 是否空闲（非 streaming 状态） */
	isIdle(): boolean;
	/** 中止当前 Agent 操作 */
	abort(): void;
	/** 是否有排队的消息 */
	hasPendingMessages(): boolean;
	/** 优雅关闭并退出 */
	shutdown(): void;
	/** 获取当前有效的系统提示 */
	getSystemPrompt(): string[];
}

/**
 * 命令处理器的扩展上下文。
 * 包含仅对用户发起的命令安全的会话控制方法。
 */
export interface ExtensionCommandContext extends ExtensionContext {
	getContextUsage(): ContextUsage | undefined;
	/** 等待 Agent 完成 streaming */
	waitForIdle(): Promise<void>;
	/** 新建会话 */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
	/** 从指定条目分支 */
	branch(entryId: string): Promise<{ cancelled: boolean }>;
	/** 导航到会话树的不同节点 */
	navigateTree(
		targetId: string,
		options?: {
			summarize?: boolean;
		},
	): Promise<{ cancelled: boolean }>;
	/** 切换到不同的会话文件 */
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	/** 重新加载当前会话/运行时状态 */
	reload(): Promise<void>;
	/** 压缩会话上下文 */
	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
}

/** 工具结果渲染选项 */
export interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
	spinnerFrame?: number;
}

/** 工具会话生命周期事件 */
export interface ToolSessionEvent {
	reason: "start" | "switch" | "branch" | "tree" | "shutdown";
	previousSessionFile: string | undefined;
}

/**
 * 工具定义 —— 用于 registerTool()
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	/** 工具名称（LLM 工具调用中使用） */
	name: string;
	/** 人类可读的 UI 标签 */
	label: string;
	/** LLM 使用的描述 */
	description: string;
	/** 参数 schema（Zod 或 TypeBox） */
	parameters: TParams;
	/** 是否隐藏（除非在 --tools 中显式列出） */
	hidden?: boolean;
	/** 是否默认不激活（注册后需手动激活） */
	defaultInactive?: boolean;
	/** 是否支持延迟变更（需要显式 resolve/discard） */
	deferrable?: boolean;
	/** MCP 服务器名称（用于发现/搜索元数据） */
	mcpServerName?: string;
	/** 原始 MCP 工具名称 */
	mcpToolName?: string;
	/** 执行工具 */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;
	/** 会话生命周期回调 */
	onSession?: (event: ToolSessionEvent, ctx: ExtensionContext) => void | Promise<void>;
	/** 自定义工具调用显示渲染 */
	renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component;
	/** 自定义工具结果显示渲染 */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		args?: Static<TParams>,
	) => Component;
}

/** 资源发现事件 */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** 资源发现结果 */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

/** Provider 请求前事件 */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/** Provider 响应后事件 */
export interface AfterProviderResponseEvent extends ProviderResponseMetadata {
	type: "after_provider_response";
}

/** Agent 启动前事件（用户提交 prompt 后、agent 循环前） */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string[];
}

/** 消息开始事件 */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** 消息流式更新事件 */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/** 消息结束事件 */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** 工具执行开始事件 */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

/** 工具执行更新事件（增量/流式输出） */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult: unknown;
}

/** 工具执行结束事件 */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

/** 凭据被自动禁用事件 */
export interface CredentialDisabledEvent {
	type: "credential_disabled";
	provider: string;
	disabledCause: string;
}

/** 用户执行 Bash 命令事件 */
export interface UserBashEvent {
	type: "user_bash";
	command: string;
	excludeFromContext: boolean;
	cwd: string;
}

/** 用户执行 Python 代码事件 */
export interface UserPythonEvent {
	type: "user_python";
	code: string;
	excludeFromContext: boolean;
	cwd: string;
}

/** 用户输入事件（仅 interactive 模式） */
export interface InputEvent {
	type: "input";
	text: string;
	images?: ImageContent[];
	source: "interactive" | "rpc" | "extension";
}

// ---------------------------------------------------------------------------
// Tool call events
// ---------------------------------------------------------------------------

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: Record<string, unknown>;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface SearchToolCallEvent extends ToolCallEventBase {
	toolName: "search";
	input: SearchToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/** 工具调用事件联合类型 */
export type ToolCallEvent =
	| BashToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| SearchToolCallEvent
	| FindToolCallEvent
	| CustomToolCallEvent;

// ---------------------------------------------------------------------------
// Tool result events
// ---------------------------------------------------------------------------

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface SearchToolResultEvent extends ToolResultEventBase {
	toolName: "search";
	details: SearchToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** 工具结果事件联合类型 */
export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| SearchToolResultEvent
	| FindToolResultEvent
	| CustomToolResultEvent;

// ---------------------------------------------------------------------------
// Event results
// ---------------------------------------------------------------------------

/** 上下文事件处理结果 */
export interface ContextEventResult {
	messages?: AgentMessage[];
}

/** Provider 请求前事件处理结果 */
export type BeforeProviderRequestEventResult = unknown;

/** 输入事件处理结果 */
export interface InputEventResult {
	handled?: boolean;
	text?: string;
	images?: ImageContent[];
}

/** 用户 Bash 事件处理结果 */
export interface UserBashEventResult {
	result?: BashResult;
}

/** 用户 Python 事件处理结果 */
export interface UserPythonEventResult {
	result?: PythonResult;
}

/** Agent 启动前事件处理结果 */
export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">;
	/** 替换本轮的系统提示。多个扩展返回时，最后一个返回 systemPrompt 的扩展决定最终值。注意：运行时是 string，非 string[]。 */
	systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Union of all event types
// ---------------------------------------------------------------------------

/** 所有事件类型的联合 */
export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| GoalUpdatedEvent
	| CredentialDisabledEvent
	| UserBashEvent
	| UserPythonEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

// ---------------------------------------------------------------------------
// Renderers and commands
// ---------------------------------------------------------------------------

/** 消息渲染选项 */
export interface MessageRenderOptions {
	expanded: boolean;
}

/** 消息渲染器 */
export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

/** Assistant 思考渲染上下文 */
export interface AssistantThinkingRenderContext {
	contentIndex: number;
	thinkingIndex: number;
	text: string;
	requestRender(): void;
}

/** Assistant 思考渲染器 */
export type AssistantThinkingRenderer = (
	context: AssistantThinkingRenderContext,
	theme: Theme,
) => Component | undefined;

/** 注册的命令 */
export interface RegisteredCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** 事件处理器函数类型 */
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

/** Provider 模型配置 */
export interface ProviderModelConfig {
	id: string;
	name: string;
	api?: Api;
	reasoning: boolean;
	thinking?: Model["thinking"];
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	premiumMultiplier?: number;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
}

/** Provider 注册配置 */
export interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: ProviderModelConfig[];
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey?(credentials: OAuthCredentials): string;
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

// ---------------------------------------------------------------------------
// ExtensionAPI
// ---------------------------------------------------------------------------

/**
 * ExtensionAPI — Core interface passed to extension factory functions (flat plain object, no nested properties).
 *
 * Extracted from @earendil-works/pi-coding-agent@0.78.1 runtime source (loader.js createExtensionAPI).
 * docs/INSTRUCTION.md §1 is the authoritative contract document.
 *
 * Extensions use this interface to:
 * - Subscribe to Agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with users through UI primitives
 */
export interface ExtensionAPI {
	// NOTE: The following properties do not exist at runtime; type definitions kept only for backward compatibility.
	// Always use ?. optional chaining before access, or import directly from the corresponding package:
	//   - logger -> no equivalent, guard with ?.
	//   - typebox -> import { Type } from "typebox"
	//   - zod -> not used
	//   - pi -> not used
	/** @deprecated Not available at runtime, guard with ?. */
	logger?: PiLogger;
	/** @deprecated Not available at runtime, use import { Type } from "typebox" */
	typebox?: TypeBoxModule;
	/** @deprecated Not available at runtime */
	zod?: ZodModule;
	/** @deprecated Not available at runtime */
	pi?: PiCodingAgent;

	// --- 事件订阅 ---

	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
	on(
		event: "session_before_branch",
		handler: ExtensionHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>,
	): void;
	on(event: "session_branch", handler: ExtensionHandler<SessionBranchEvent>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session.compacting", handler: ExtensionHandler<SessionCompactingEvent, SessionCompactingResult>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "auto_compaction_start", handler: ExtensionHandler<AutoCompactionStartEvent>): void;
	on(event: "auto_compaction_end", handler: ExtensionHandler<AutoCompactionEndEvent>): void;
	on(event: "auto_retry_start", handler: ExtensionHandler<AutoRetryStartEvent>): void;
	on(event: "auto_retry_end", handler: ExtensionHandler<AutoRetryEndEvent>): void;
	on(event: "ttsr_triggered", handler: ExtensionHandler<TtsrTriggeredEvent>): void;
	on(event: "todo_reminder", handler: ExtensionHandler<TodoReminderEvent>): void;
	on(event: "goal_updated", handler: ExtensionHandler<GoalUpdatedEvent>): void;
	on(event: "credential_disabled", handler: ExtensionHandler<CredentialDisabledEvent>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "user_python", handler: ExtensionHandler<UserPythonEvent, UserPythonEventResult>): void;

	// --- Registration ---

	/** Register an LLM-callable tool */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
	/** Register a custom command */
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void;
	/** Register a keyboard shortcut */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;
	/** Register a CLI flag */
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;

	// --- Labels & Flags ---

	/** Set the extension display label, or set a label for a specific entry */
	setLabel(entryIdOrLabel: string, label?: string | undefined): void;
	/** Get registered CLI flag values */
	getFlag(name: string): boolean | string | undefined;

	// --- Renderers ---

	/** Register a custom renderer for CustomMessageEntry */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
	/** Register an assistant thinking block renderer */
	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void;

	// --- Messages & Sessions ---

	/**
	 * Send a custom message to the session.
	 *
	 * `deliverAs: "nextTurn"` hides the message from the editable pending-message UI.
	 * If `triggerTurn` is also true and the current turn is still being processed,
	 * the session will schedule an internal continuation to consume the message
	 * in the next turn.
	 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
		},
	): void;
	/** Send a user message to the Agent, or queue when deliverAs is set */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: {
			deliverAs?: "steer" | "followUp";
		},
	): void;
	/** Append a custom entry to the session for state persistence (not sent to LLM) */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	// --- Execution ---

	/** Execute a shell command */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	// --- Tool Management ---

	/** Get currently active tool names */
	getActiveTools(): string[];
	/** Get all configured tools (built-in + extensions) */
	getAllTools(): string[];
	/** Set active tools */
	setActiveTools(toolNames: string[]): Promise<void>;

	// --- Commands ---

	/** Get available slash commands for the current session */
	getCommands(): SlashCommandInfo[];

	// --- Models ---

	/** Set the current model. Returns false if no API key is available */
	setModel(model: Model): Promise<boolean>;
	/** Get the current thinking level */
	getThinkingLevel(): ThinkingLevel | undefined;
	/** Set the thinking level for the current session */
	setThinkingLevel(level: ThinkingLevel): void;

	// --- Session ---

	/** Get the current session name */
	getSessionName(): string | undefined;
	/** Set the session name (persisted to session file) */
	setSessionName(name: string): Promise<void>;

	// --- Provider ---

	/**
	 * Register or override a model Provider.
	 *
	 * If `models` is provided: replaces all existing models for this Provider.
	 * If only `baseUrl` is provided: overrides the URL of existing models.
	 * If `streamSimple` is provided: registers a custom API stream handler.
	 */
	registerProvider(name: string, config: ProviderConfig): void;

	// --- Event Bus ---

	/** Shared event bus for inter-extension communication */
	events: EventBus;
}

// ---------------------------------------------------------------------------
// Extension factory and runtime types
// ---------------------------------------------------------------------------

/** Extension factory function type (supports sync and async initialization) */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** Registered tool */
export interface RegisteredTool<TParams extends TSchema = TSchema, TDetails = unknown> {
	definition: ToolDefinition<TParams, TDetails>;
	extensionPath: string;
}

/** Extension CLI flag */
export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

/** Extension shortcut */
export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

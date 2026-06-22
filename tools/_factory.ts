/**
 * pi-shazam tools/_factory — Tool registration factory.
 *
 * Eliminates per-tool boilerplate by centralizing:
 * - json/maxTokens parameter defaults (merged with tool-specific params)
 * - scanProject(".") graph creation
 * - JSON/text output toggle with standard envelope
 * - maxTokens truncation
 * - AgentToolResult content envelope wrapping
 *
 * Tools with simple domain logic use the `execute` callback (receives graph + params).
 * Tools with complex custom logic (async LSP, multi-branch) use `customExecute`
 * which bypasses auto-scan and envelope wrapping but still gets merged params.
 */
import type {
	ExtensionAPI,
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "../types/pi-extension.js";
import { Type, type TProperties, type TObject } from "typebox";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { truncateOutput } from "../core/output.js";
import { resolve } from "node:path";

// ── Path traversal guard ────────────────────────────────────────────────────

/**
 * 校验给定路径是否在项目根目录内，防止路径穿越攻击。
 * 先 resolve 为绝对路径，再检测是否以 projectRoot + "/" 开头或等于 projectRoot。
 * 不在项目范围内的路径返回 false。
 */
export function validatePathInProject(rawPath: string, projectRoot: string = process.cwd()): boolean {
	const resolved = resolve(projectRoot, rawPath);
	const rootResolved = resolve(projectRoot);
	return resolved.startsWith(rootResolved + "/") || resolved === rootResolved;
}

// ── Envelope helper ────────────────────────────────────────────────────────

/**
 * Build a standardized JSON envelope for tool output.
 * Used by all tools to produce consistent schema_version/command/project/status/result.
 */
export function buildEnvelope(name: string, project: string, status: "ok" | "error", result: unknown): string {
	return JSON.stringify(
		{
			schema_version: "1.0",
			command: name.replace("shazam_", ""),
			project,
			status,
			result,
		},
		null,
		2,
	);
}

// ── Factory types ──────────────────────────────────────────────────────────

export interface ToolSpec<T extends TProperties> {
	name: string;
	label: string;
	description: string;
	params: TObject<T>;
	/**
	 * Standard domain function: receives pre-scanned graph and merged params,
	 * returns text output. Factory handles envelope, json toggle, truncation.
	 */
	execute?: (graph: RepoGraph, params: Record<string, unknown>) => string | Promise<string>;
	/**
	 * Custom execute for tools with complex logic (async LSP, multi-branch).
	 * Receives the full execute context. Factory only merges params.
	 * Tool handles its own scanProject, envelope, json toggle, truncation.
	 */
	customExecute?: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<unknown> | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult>;
}

// ── Factory function ───────────────────────────────────────────────────────

/**
 * Register a tool with automatic parameter merging and optional boilerplate.
 *
 * - If `execute` is provided: factory handles scanProject, json toggle,
 *   envelope wrapping, and maxTokens truncation.
 * - If `customExecute` is provided: tool handles everything; factory only
 *   merges json/maxTokens into the parameter schema.
 */
export function createTool<T extends TProperties>(pi: ExtensionAPI, spec: ToolSpec<T>): void {
	const mergedSchema = Type.Object({
		...spec.params.properties,
		json: Type.Optional(Type.Boolean()),
		maxTokens: Type.Optional(Type.Number()),
	});

	if (spec.customExecute) {
		pi.registerTool({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			parameters: mergedSchema,
			execute: spec.customExecute,
		});
		return;
	}

	if (!spec.execute) {
		throw new Error(`Tool ${spec.name}: either execute or customExecute must be provided`);
	}

	const domainFn = spec.execute;

	pi.registerTool({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		parameters: mergedSchema,
		async execute(_toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult> {
			const json = (params.json as boolean) ?? false;
			const maxTokens = params.maxTokens as number | undefined;
			const project = process.cwd();
			params.project = project;
			const graph = scanProject(".");

			let text: string;
			try {
				text = await domainFn(graph, params);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				if (json) {
					text = buildEnvelope(spec.name, project, "error", { message: errMsg });
				} else {
					return {
						content: [{ type: "text", text: `Error: ${spec.name} failed — ${errMsg}` }],
						isError: true,
					};
				}
			}

			if (json) {
				try {
					const parsed = JSON.parse(text);
					text = JSON.stringify(parsed, null, 2);
				} catch {
					text = JSON.stringify(
						{
							schema_version: "1.0",
							command: spec.name.replace("shazam_", ""),
							status: "ok",
							result: text,
						},
						null,
						2,
					);
				}
			}

			if (typeof maxTokens === "number" && maxTokens > 0 && !json) {
				text = truncateOutput(text.split("\n"), maxTokens);
			}

			return {
				content: [
					{
						type: "text",
						text,
					},
				],
			};
		},
	});
}

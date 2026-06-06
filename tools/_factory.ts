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
			const graph = scanProject(".");

			let text = await domainFn(graph, params);

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

			if (maxTokens && !json) {
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

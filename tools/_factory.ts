/**
 * pi-shazam tools/_factory -- Tool registration factory.
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
import { scanProject, getEffectiveRoot } from "../core/scanner.js";
import { truncateOutput, _logWarn } from "../core/output.js";
import { setLastToolTiming } from "./_context.js";
import { resolve, relative, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { normalizePathInput } from "../core/path-utils.js";

// -- Path traversal guard ----------------------------------------------------

/**
 * Cross-platform path-containment check (#463).
 *
 * Uses `relative()` + `isAbsolute()` instead of `startsWith(root + "/")`
 * because `path.resolve()` returns backslash-separated paths on Windows,
 * where a forward-slash prefix never matches and rejects every valid
 * subpath. `relative()` respects the host platform's separator semantics,
 * so this returns true iff `target` is `root` itself or nested inside it.
 *
 * Mirrors the already-correct `isPathInRoot` in lsp/manager.ts.
 */
export function isPathInRoot(target: string, root: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validate that a given path is within the project root, preventing path traversal attacks.
 * First resolves to an absolute path, then checks containment via isPathInRoot
 * (platform-agnostic; works on Windows backslash paths as well as POSIX).
 * Returns false for paths outside the project scope.
 */
export function validatePathInProject(rawPath: string, projectRoot: string = getEffectiveRoot()): boolean {
	// #673: normalize Git-Bash /c/foo and WSL /mnt/c/foo to C:\foo on Windows.
	const safePath = normalizePathInput(rawPath);
	const resolved = resolve(projectRoot, safePath);
	const rootResolved = resolve(projectRoot);
	// Containment check: platform-agnostic via relative(), not startsWith(root + "/").
	if (!isPathInRoot(resolved, rootResolved)) return false;
	// Verify resolved real path is also within project root (prevents symlink escape)
	try {
		const realResolved = realpathSync(resolved);
		const realRoot = realpathSync(rootResolved);
		return isPathInRoot(realResolved, realRoot);
	} catch (err) {
		// ENOENT means the agent asked for a path that does not exist on
		// disk -- the expected outcome of a negative probe. Return false
		// silently so the caller can produce a clean "not found" result;
		// a stderr line on every miss is user-visible noise (#632 UX
		// principle: policy/observation notes go to the LLM, not stderr).
		// Other errors (EACCES, ELOOP, ENOTDIR) signal a real filesystem
		// issue worth surfacing.
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		_logWarn("validatePathInProject", `realpathSync failed for ${resolved}`, err);
		return false;
	}
}

// -- Envelope helper --------------------------------------------------------
// Definition sunk into core/output.ts (issue #716); re-exported here so all
// existing tools/_factory.js importers (tools/*.ts, tests) keep working.
import { buildEnvelope } from "../core/output.js";
export { buildEnvelope };

// -- Factory types ----------------------------------------------------------

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

// -- Factory function -------------------------------------------------------

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
			// #464: use the configured project root (getEffectiveRoot) instead of
			// process.cwd() so filesystem/git operations target the correct dir
			// when Pi is launched from a parent directory or MCP is launched with
			// an explicit project-root argument. scanProject(".") already honors
			// the override; this aligns the injected params.project with it.
			// Note: customExecute tools must import getEffectiveRoot() from scanner
			// for path validation, as the factory does not inject the override.
			const project = getEffectiveRoot();
			// L7: Avoid mutating caller's params object -- use spread to create a new one
			const effectiveParams = { ...params, project };
			const graph = scanProject(".");

			// Issue #731: non-overview tools must also surface the truncated flag
			// so the agent knows results may be incomplete when MAX_FILES was hit.
			const truncatedWarning =
				graph.truncated === true
					? "\n\n[WARNING] File count exceeded MAX_FILES — the analysis graph is incomplete. Results may miss dependencies."
					: "";

			let text: string;
			try {
				const t0 = Date.now();
				text = await domainFn(graph, effectiveParams);
				const totalMs = Date.now() - t0;
				setLastToolTiming({ formatOutput: totalMs });
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				_logWarn("createTool", `${spec.name} domainFn failed`, err);
				if (json) {
					text = buildEnvelope(spec.name, project, "error", { message: errMsg });
				} else {
					return {
						content: [{ type: "text", text: `Error: ${spec.name} failed - ${errMsg}` }],
						isError: true,
					};
				}
			}

			if (json) {
				try {
					const parsed = JSON.parse(text);
					text = JSON.stringify(parsed, null, 2);
				} catch (err) {
					_logWarn("createTool", `JSON.parse failed for ${spec.name} output`, err);
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

			if (truncatedWarning && !json) {
				text += truncatedWarning;
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

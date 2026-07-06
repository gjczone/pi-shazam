/**
 * pi-shazam tools/definitions -- Shared tool definitions.
 *
 * Single source of truth for tool names, descriptions, and parameter schemas.
 * Both Pi (TypeBox) and MCP (Zod) import from here to avoid duplication.
 *
 * 7 tools (consolidated from 14; issues #362, #497):
 *   overview, lookup, impact, verify, changes, format, rename_symbol
 */
import { Type } from "typebox";
import { z } from "zod";

// -- Tool Definition Interface ----------------------------------------------

export interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	typeboxParams: ReturnType<typeof Type.Object>;
	zodParams: z.ZodObject<Record<string, z.ZodType>>;
}

// -- Shared Tool Definitions ------------------------------------------------

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
	shazam_overview: {
		name: "shazam_overview",
		label: "Project Overview",
		description:
			"When you first enter a project or return after changes - use this to understand the codebase before reading a single file. Returns module dependency map, top-10 PageRank files, key dependencies, recent git changes, entry points, reading order, HTTP routes, and complexity hotspots ranked by blast radius.",
		typeboxParams: Type.Object({
			filter: Type.Optional(Type.String()),
		}),
		zodParams: z.object({
			filter: z.string().optional().describe("Optional keyword to filter files"),
			maxTokens: z.number().int().positive().optional().describe("Max tokens in output"),
			json: z.boolean().optional().describe("Return structured JSON output"),
		}),
	},

	shazam_lookup: {
		name: "shazam_lookup",
		label: "Lookup Symbol or File",
		description:
			"Look up anything in the codebase - a symbol by name or a file by path. Auto-detects whether the input is a file path or symbol name and returns the most relevant information: definition, kind, signature, type hierarchy, file structure, PageRank, callers/callees. Use mode=state for enum/state analysis. Pass showCallbacks=true to expand anonymous functions.",
		typeboxParams: Type.Object({
			name: Type.String(),
			file: Type.Optional(Type.String()),
			mode: Type.Optional(Type.String()),
			showCallbacks: Type.Optional(Type.Boolean()),
			direction: Type.Optional(
				Type.Union([Type.Literal("both"), Type.Literal("supertypes"), Type.Literal("subtypes")]),
			),
		}),
		zodParams: z.object({
			name: z.string().describe("Symbol name or file path to look up"),
			file: z.string().optional().describe("Optional file path to scope the search"),
			mode: z
				.enum(["state", "search"])
				.optional()
				.describe("Use 'state' for enum/state map analysis, or 'search' for concept/fuzzy search"),
			showCallbacks: z.boolean().optional().describe("Expand anonymous functions (default: collapsed)"),
			direction: z
				.enum(["both", "supertypes", "subtypes"])
				.optional()
				.default("both")
				.describe("Type hierarchy direction"),
			maxTokens: z.number().int().positive().optional().describe("Max tokens in output"),
			json: z.boolean().optional().describe("Return structured JSON output"),
		}),
	},

	shazam_impact: {
		name: "shazam_impact",
		label: "Change Impact Analysis",
		description:
			"Required before editing 2+ files or any shared/exported module. Returns every file, symbol, and test affected by your planned changes. Pass --symbol for per-symbol caller/callee tracing. Pass --flat for a flat list of references. Pass --direction to filter by incoming/outgoing/both. Pass --with-symbols for per-symbol risk breakdown. Pass --compact for concise output. Pass --depth to control BFS traversal depth (default 3).",
		typeboxParams: Type.Object({
			files: Type.Optional(Type.Array(Type.String())),
			symbol: Type.Optional(Type.String()),
			withSymbols: Type.Optional(Type.Boolean()),
			compact: Type.Optional(Type.Boolean()),
			depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
			flat: Type.Optional(Type.Boolean()),
			direction: Type.Optional(
				Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")], {
					default: "both",
				}),
			),
		}),
		zodParams: z.object({
			files: z.array(z.string()).optional().describe("List of file paths to analyze"),
			symbol: z.string().optional().describe("Symbol name for call chain analysis"),
			withSymbols: z.boolean().optional().describe("Show per-symbol risk breakdown"),
			compact: z.boolean().optional().describe("Concise output (file names only)"),
			depth: z.number().int().min(1).max(10).optional().default(3).describe("BFS traversal depth (default 3)"),
			flat: z.boolean().optional().default(false).describe("Return a flat list of all references"),
			direction: z
				.enum(["incoming", "outgoing", "both"])
				.optional()
				.default("both")
				.describe("Filter by direction: incoming callers, outgoing callees, or both"),
			maxTokens: z.number().int().positive().optional().describe("Max tokens in output"),
			json: z.boolean().optional().describe("Return structured JSON output"),
		}),
	},

	shazam_verify: {
		name: "shazam_verify",
		label: "Verify Changes",
		description:
			"After every write or edit, run this to confirm no errors were introduced. Runs LSP diagnostics (type errors, warnings), then graph analysis (git diff, risk level, orphan detection, graph diffs). Verdict: PASS / WARN / FAIL. Use --quick for a fast git-change-only check (~2s). Use --lspOnly for diagnostics only. Use --preCommit for stricter thresholds. The `maxFiles` cap is configured in `.pi-shazam/config.json` under `verify.maxFiles` (default 100).",
		typeboxParams: Type.Object({
			quick: Type.Optional(Type.Boolean()),
			lspOnly: Type.Optional(Type.Boolean()),
			preCommit: Type.Optional(Type.Boolean()),
			// #630: maxFiles, noCascade, noSecrets moved to .pi-shazam/config.json.
			// noCascade and noSecrets were never read anywhere (dead options).
			maxTokens: Type.Optional(Type.Number()),
			json: Type.Optional(Type.Boolean()),
		}),
		zodParams: z.object({
			quick: z.boolean().optional().default(false).describe("Fast git-change-only check (~2s)"),
			lspOnly: z.boolean().optional().default(false).describe("LSP diagnostics only, skip graph analysis"),
			preCommit: z.boolean().optional().default(false).describe("Stricter thresholds for pre-commit gate"),
			maxTokens: z.number().int().positive().optional().describe("Max tokens in output"),
			json: z.boolean().optional().describe("Return structured JSON output"),
		}),
	},

	shazam_changes: {
		name: "shazam_changes",
		label: "Change Summary",
		description:
			"Without this, you optimize the wrong files. Returns a concise summary of what changed in the working tree: changed files, affected symbols, risk level, and which callers may be impacted. Use after edits to see the blast radius before running full verification.",
		typeboxParams: Type.Object({}),
		zodParams: z.object({
			maxTokens: z.number().int().positive().optional().describe("Max tokens in output"),
			json: z.boolean().optional().describe("Return structured JSON output"),
		}),
	},

	shazam_format: {
		name: "shazam_format",
		label: "Auto-Format Code",
		description:
			"When shazam_verify reports format or lint errors, use this to auto-fix them. Runs nearest-wins formatters (prettier, biome, eslint --fix, ruff, cargo fmt, gofmt). Format only - never touches logic. Use --dry-run to preview when unsure.",
		typeboxParams: Type.Object({
			dryRun: Type.Optional(Type.Boolean({ default: true })),
			file: Type.Optional(Type.String()),
		}),
		zodParams: z.object({
			dryRun: z.boolean().optional().default(true).describe("Preview changes without applying"),
			file: z.string().optional().describe("Scope to a single file"),
			maxTokens: z.number().int().positive().optional().describe("Max tokens in output"),
			json: z.boolean().optional().describe("Return structured JSON output"),
		}),
	},

	shazam_rename_symbol: {
		name: "shazam_rename_symbol",
		label: "Rename Symbol",
		description:
			"Required safety gate before renaming any symbol. Step 1: call shazam_impact --symbol to review all references. Step 2: use this to perform the project-wide rename via LSP textDocument/rename. Step 3: call shazam_verify to confirm no broken references. This is a WRITE operation - do not manually find-and-replace; missed references become bugs.",
		typeboxParams: Type.Object({
			symbol: Type.String(),
			newName: Type.String(),
			dryRun: Type.Optional(Type.Boolean({ default: true })),
		}),
		zodParams: z.object({
			symbol: z.string().describe("Current symbol name to rename"),
			newName: z.string().describe("New symbol name"),
			dryRun: z.boolean().optional().default(true).describe("Preview only, do not modify files"),
			maxTokens: z.number().int().positive().optional().describe("Max tokens in output"),
			json: z.boolean().optional().describe("Return structured JSON output"),
		}),
	},
};

// -- Helper Functions --------------------------------------------------------

/**
 * Get all tool definitions as an array.
 */
export function getAllToolDefinitions(): ToolDefinition[] {
	return Object.values(TOOL_DEFINITIONS);
}

/**
 * Get a tool definition by name.
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
	return TOOL_DEFINITIONS[name];
}

/**
 * Get all tool names.
 */
export function getToolNames(): string[] {
	return Object.keys(TOOL_DEFINITIONS);
}

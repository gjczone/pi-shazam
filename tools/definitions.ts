/**
 * pi-shazam tools/definitions — Shared tool definitions.
 *
 * Single source of truth for tool names, descriptions, and parameter schemas.
 * Both Pi (TypeBox) and MCP (Zod) import from here to avoid duplication.
 */
import { Type } from "typebox";
import { z } from "zod";

// ── Tool Definition Interface ──────────────────────────────────────────────

export interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	typeboxParams: ReturnType<typeof Type.Object>;
	zodParams: z.ZodObject<Record<string, z.ZodType>>;
}

// ── Shared Tool Definitions ────────────────────────────────────────────────

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
	shazam_overview: {
		name: "shazam_overview",
		label: "Project Overview",
		description:
			"When you first enter a project or return after changes — use this to understand the codebase before reading a single file. Returns module dependency map, top-10 PageRank files, key dependencies, recent git changes, entry points, reading order, and HTTP routes.",
		typeboxParams: Type.Object({
			filter: Type.Optional(Type.String()),
		}),
		zodParams: z.object({
			filter: z.string().optional().describe("Optional keyword to filter files"),
		}),
	},

	shazam_impact: {
		name: "shazam_impact",
		label: "Change Impact Analysis",
		description:
			"Required before editing 2+ files or any shared/exported module. Returns every file, symbol, and test affected by your planned changes. Without this, you are guessing which tests to run and which callers to update. Pass --with-symbols for per-symbol risk breakdown. Pass --compact for concise output (file names only). Pass --depth to control BFS traversal depth (default 3). Supports multiple --files.",
		typeboxParams: Type.Object({
			files: Type.Array(Type.String()),
			withSymbols: Type.Optional(Type.Boolean()),
			compact: Type.Optional(Type.Boolean()),
			depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
		}),
		zodParams: z.object({
			files: z.array(z.string()).describe("List of file paths to analyze"),
			withSymbols: z.boolean().optional().describe("Show per-symbol risk breakdown"),
			compact: z.boolean().optional().describe("Concise output (file names only)"),
			depth: z.number().int().min(1).max(10).optional().default(3).describe("BFS traversal depth (default 3)"),
		}),
	},

	shazam_codesearch: {
		name: "shazam_codesearch",
		label: "Code Search",
		description:
			'Don\'t reach for grep or raw text search. Use this — it ranks results by relevance (BM25), understands camelCase/snake_case boundaries, and enriches hits with LSP workspace symbols. Two modes: target="symbol" (default, semantic ranking) and target="code" (full-text with context snippets via ripgrep).',
		typeboxParams: Type.Object({
			query: Type.String(),
			target: Type.Optional(Type.Union([Type.Literal("symbol"), Type.Literal("code")], { default: "symbol" })),
			mode: Type.Optional(
				Type.Union([Type.Literal("literal"), Type.Literal("regex"), Type.Literal("smart")], {
					default: "literal",
				}),
			),
			topN: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
			maxTokens: Type.Optional(Type.Number()),
		}),
		zodParams: z.object({
			query: z.string().describe("Search query text"),
			target: z.enum(["symbol", "code"]).optional().default("symbol").describe("symbol or code"),
			mode: z
				.enum(["literal", "regex", "smart"])
				.optional()
				.default("literal")
				.describe("Search mode for target=code: literal (exact), regex (tokenized), smart (auto-detect NL)"),
			topN: z.number().optional().describe("Max results to return"),
			maxTokens: z.number().optional().describe("Max tokens in output"),
		}),
	},

	shazam_symbol: {
		name: "shazam_symbol",
		label: "Symbol Lookup",
		description:
			"When you need to look up a symbol before importing or calling it — returns definition, kind, signature, callers, and callees in one call. Use mode=state for enum/state analysis.",
		typeboxParams: Type.Object({
			name: Type.String(),
			file: Type.Optional(Type.String()),
			mode: Type.Optional(Type.Union([Type.Literal("state")])),
			json: Type.Optional(Type.Boolean()),
			maxTokens: Type.Optional(Type.Number()),
		}),
		zodParams: z.object({
			name: z.string().describe("Symbol name to look up"),
			mode: z.enum(["state"]).optional().describe("Use 'state' for enum/state map analysis"),
			file: z.string().optional().describe("Optional file path to scope the search"),
			json: z.boolean().optional().describe("Return structured JSON output"),
			maxTokens: z.number().optional().describe("Max tokens in output"),
		}),
	},

	shazam_file_detail: {
		name: "shazam_file_detail",
		label: "File Detail",
		description:
			"When you are about to edit a file you have not read before — this shows structure (symbols, signatures, visibility, PageRank), not just syntax. Also surfaces LSP document symbol hierarchy for parent-child relationships.",
		typeboxParams: Type.Object({
			file: Type.String(),
		}),
		zodParams: z.object({
			file: z.string().describe("Path to the file to analyze"),
		}),
	},

	shazam_call_chain: {
		name: "shazam_call_chain",
		label: "Call Chain",
		description:
			"Without this, you ship bugs. Traces ALL upstream callers, downstream callees, and references for any symbol. Pass --depth to control traversal depth (default 2). Pass --flat for a simple flat list of all references. Pass --direction to filter by incoming/outgoing/both (default both).",
		typeboxParams: Type.Object({
			symbol: Type.String(),
			depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
			flat: Type.Optional(Type.Boolean()),
			direction: Type.Optional(
				Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")], {
					default: "both",
				}),
			),
		}),
		zodParams: z.object({
			symbol: z.string().describe("Symbol name to trace"),
			depth: z.number().int().min(1).max(10).optional().default(2).describe("Traversal depth (default 2)"),
			flat: z.boolean().optional().default(false).describe("Return a flat list of all references"),
			direction: z
				.enum(["incoming", "outgoing", "both"])
				.optional()
				.default("both")
				.describe("Filter by direction: incoming callers, outgoing callees, or both (default)"),
		}),
	},

	shazam_hover: {
		name: "shazam_hover",
		label: "Symbol Hover",
		description:
			"After finding a symbol, use this to get its full type signature, documentation comments, and JSDoc — content that raw file reads miss. Connects to LSP hover providers for rich type info. Falls back to graph metadata when LSP is unavailable.",
		typeboxParams: Type.Object({
			name: Type.String(),
			file: Type.Optional(Type.String()),
		}),
		zodParams: z.object({
			name: z.string().describe("Symbol name"),
			file: z.string().optional().describe("Optional file path to scope lookup"),
		}),
	},

	shazam_find_tests: {
		name: "shazam_find_tests",
		label: "Find Test Files",
		description:
			"When adding tests or modifying source code — use this to discover which test files already cover a module, what test functions exist, and where new tests belong. Understands conventions for JS/TS (*.test.ts, *.spec.ts), Python (test_*.py / *_test.py), Go (*_test.go), Rust (test_*.rs / *_test.rs), Java (Test*.java / *Test.java), and C# (Test*.cs / *Test.cs). Pass sourceFile or module to scope the search.",
		typeboxParams: Type.Object({
			sourceFile: Type.Optional(Type.String()),
			module: Type.Optional(Type.String()),
		}),
		zodParams: z.object({
			sourceFile: z.string().optional().describe("Path to source file to find tests for"),
			module: z.string().optional().describe("Module name to scope search"),
		}),
	},

	shazam_hotspots: {
		name: "shazam_hotspots",
		label: "Code Hotspots",
		description:
			"Without this, you optimize the wrong files. Returns files ranked by (symbol density x PageRank) — these are the files where bugs have the highest blast radius. Use to prioritize code review, decide where to write tests first, and understand which files form the project's core.",
		typeboxParams: Type.Object({
			topN: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
		}),
		zodParams: z.object({ topN: z.number().optional().describe("Max results to return") }),
	},

	shazam_verify: {
		name: "shazam_verify",
		label: "Verify Changes",
		description:
			"After every write or edit, run this to confirm no errors were introduced. Runs LSP diagnostics (type errors, warnings), then graph analysis (git diff, risk level, orphan detection, graph diffs). Verdict: PASS / WARN / FAIL. Use --quick for a fast git-change-only check (~2s). Use --lspOnly for diagnostics only. Use --preCommit for stricter thresholds.",
		typeboxParams: Type.Object({
			quick: Type.Optional(Type.Boolean()),
			lspOnly: Type.Optional(Type.Boolean()),
			preCommit: Type.Optional(Type.Boolean()),
			delta: Type.Optional(Type.Boolean()),
			maxFiles: Type.Optional(Type.Number()),
			noCascade: Type.Optional(Type.Boolean()),
			noSecrets: Type.Optional(Type.Boolean()),
		}),
		zodParams: z.object({
			quick: z.boolean().optional().default(false).describe("Fast git-change-only check (~2s)"),
			lspOnly: z.boolean().optional().default(false).describe("LSP diagnostics only, skip graph analysis"),
			preCommit: z.boolean().optional().default(false).describe("Stricter thresholds for pre-commit gate"),
			delta: z.boolean().optional().default(false).describe("Only check changed files"),
			maxFiles: z.number().optional().describe("Max files to check"),
			noCascade: z.boolean().optional().default(false).describe("Skip cascade analysis"),
			noSecrets: z.boolean().optional().default(false).describe("Skip secrets detection"),
		}),
	},

	shazam_type_hierarchy: {
		name: "shazam_type_hierarchy",
		label: "Type Hierarchy",
		description:
			"When working with classes, interfaces, or abstract types — use this to see the full inheritance chain (supertypes and subtypes) in one call. Uses LSP 3.17 typeHierarchy protocol with graph inheritance edge fallback. Before refactoring a base class, finding all interface implementations, or adding methods to a parent type.",
		typeboxParams: Type.Object({
			name: Type.String(),
			direction: Type.Optional(
				Type.Union([Type.Literal("both"), Type.Literal("supertypes"), Type.Literal("subtypes")]),
			),
		}),
		zodParams: z.object({
			name: z.string().describe("Symbol name"),
			direction: z.enum(["both", "supertypes", "subtypes"]).optional().default("both").describe("Traversal direction"),
		}),
	},

	shazam_rename_symbol: {
		name: "shazam_rename_symbol",
		label: "Rename Symbol",
		description:
			"Required safety gate before renaming any symbol. Step 1: call shazam_call_chain to review all references. Step 2: use this to perform the project-wide rename via LSP textDocument/rename. Step 3: call shazam_verify to confirm no broken references. This is a WRITE operation — do not manually find-and-replace; missed references become bugs.",
		typeboxParams: Type.Object({
			symbol: Type.String(),
			newName: Type.String(),
			dryRun: Type.Optional(Type.Boolean({ default: true })),
		}),
		zodParams: z.object({
			symbol: z.string().describe("Current symbol name to rename"),
			newName: z.string().describe("New symbol name"),
			dryRun: z.boolean().optional().default(true).describe("Preview only, do not modify files"),
		}),
	},

	shazam_safe_delete: {
		name: "shazam_safe_delete",
		label: "Safe Delete",
		description:
			"Required safety gate before removing any symbol. Automatically verifies zero incoming references before providing deletion instructions. READ-ONLY safety check; returns deletion guidance, does not delete Safety workflow: checks incoming references (must be 0), reports outgoing references, provides deletion guidance. Do not delete based on intuition — a symbol that looks unused may be called dynamically.",
		typeboxParams: Type.Object({
			symbol: Type.String(),
			dryRun: Type.Optional(Type.Boolean({ default: true })),
		}),
		zodParams: z.object({
			symbol: z.string().describe("Symbol name to delete"),
			dryRun: z.boolean().optional().default(true).describe("Preview only, do not modify files"),
		}),
	},

	shazam_fix: {
		name: "shazam_fix",
		label: "Auto-Fix",
		description:
			"When shazam_verify reports format or lint errors, use this to auto-fix them. Runs nearest-wins formatters (prettier, biome, eslint --fix, ruff, cargo fmt, gofmt). Format only — never touches logic. Use --dry-run to preview when unsure.",
		typeboxParams: Type.Object({
			dryRun: Type.Optional(Type.Boolean({ default: true })),
			file: Type.Optional(Type.String()),
		}),
		zodParams: z.object({
			dryRun: z.boolean().optional().default(true).describe("Preview changes without applying"),
			file: z.string().optional().describe("Scope to a single file"),
		}),
	},
};

// ── Helper Functions ────────────────────────────────────────────────────────

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

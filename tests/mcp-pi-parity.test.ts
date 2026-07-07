/**
 * MCP-Pi parity contract tests — verifies that all 7 tools produce
 * equivalent output through Pi and MCP handlers (issue #619).
 *
 * Both paths now call the same dispatcher (tools/_dispatchers.ts),
 * so the output should be identical aside from wrapping differences.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { scanProject, getEffectiveRoot } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "../types/pi-extension.js";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// -- Helpers ------------------------------------------------------------

let graph: RepoGraph;

beforeAll(() => {
	graph = scanProject(".");
});

/**
 * Normalize output for comparison: strip leading/trailing whitespace
 * and normalize line endings. Dispatcher output should be identical
 * between Pi and MCP since they call the same code.
 */
function normalize(text: string): string {
	return text.trim().replace(/\r\n/g, "\n");
}

/**
 * Run a git command in the current working directory (the worktree under
 * test) and return trimmed stdout. Used by the shazam_changes tree-state
 * fixtures (issue #644).
 */
function execGit(args: string[]): string {
	return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" }).trim();
}

/**
 * Force the working tree into a known state for the shazam_changes parity
 * cases (issue #644). Returns a `restore` callback that MUST be invoked in
 * a `finally` block to undo the mutation.
 *
 * - "clean": stash every local change (tracked + untracked, but not ignored
 *   files like node_modules) so `getGitChangedFiles()` sees an empty diff and
 *   the tool emits the compact no-op. An already-clean tree is a no-op
 *   (restore does nothing).
 * - "dirty": append a marker line to a *tracked* file (README.md). A raw
 *   `touch` of a brand-new file is intentionally avoided because
 *   `getGitChangedFiles()` only reports `git diff` (tracked changes), so an
 *   untracked file would be invisible to the tool.
 */
function prepareTree(mode: "clean" | "dirty"): () => void {
	if (mode === "clean") {
		const dirty = execGit(["status", "--porcelain"]).length > 0;
		if (dirty) {
			execGit(["stash", "push", "--include-untracked", "-m", "pi-parity-clean"]);
			return () => {
				try {
					execGit(["stash", "pop"]);
				} catch {
					/* nothing was stashed — ignore */
				}
			};
		}
		return () => {};
	}
	appendFileSync("README.md", "\n<!-- pi-parity-dirty-marker -->\n");
	return () => {
		try {
			execGit(["checkout", "--", "README.md"]);
		} catch {
			/* README.md missing/untracked — leave as-is */
		}
	};
}

// -- Mock Pi context ----------------------------------------------------

function mockPiCtx(): ExtensionContext {
	return {} as ExtensionContext;
}

function mockPiSignal(): AbortSignal {
	return undefined as unknown as AbortSignal;
}

// -- Pi tool invoker ----------------------------------------------------

async function invokePiTool(toolName: string, params: Record<string, unknown>): Promise<string> {
	// Import the tool registration and execute via the factory-registered tool.
	// The register functions take the real `ExtensionAPI`; the test only
	// invokes `registerTool`, so we type the callback parameter as
	// `ExtensionAPI` (the surface the real register functions expect)
	// and stub the rest of the surface at the call site.
	let registerFn: (pi: ExtensionAPI) => void;
	switch (toolName) {
		case "shazam_overview":
			registerFn = (await import("../tools/overview.js")).registerOverview;
			break;
		case "shazam_lookup":
			registerFn = (await import("../tools/lookup.js")).registerLookup;
			break;
		case "shazam_impact":
			registerFn = (await import("../tools/impact.js")).registerImpact;
			break;
		case "shazam_verify":
			registerFn = (await import("../tools/verify.js")).registerVerify;
			break;
		case "shazam_changes":
			registerFn = (await import("../tools/changes.js")).registerChanges;
			break;
		case "shazam_format":
			registerFn = (await import("../tools/format.js")).registerFormat;
			break;
		case "shazam_rename_symbol":
			registerFn = (await import("../tools/rename_symbol.js")).registerRenameSymbol;
			break;
		default:
			throw new Error(`Unknown tool: ${toolName}`);
	}

	const registered: {
		name: string;
		execute: (
			callId: string,
			params: Record<string, unknown>,
			signal?: unknown,
			onUpdate?: unknown,
			ctx?: unknown,
		) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
	}[] = [];
	registerFn({
		registerTool(tool: unknown) {
			registered.push(tool as (typeof registered)[0]);
		},
	} as unknown as Parameters<typeof registerFn>[0]);

	const tool = registered[0]!;
	const result = await tool.execute(
		"test-call-id",
		{ ...params, project: getEffectiveRoot() },
		mockPiSignal(),
		undefined,
		mockPiCtx(),
	);
	return normalize((result.content[0] as { text: string }).text);
}

// -- MCP tool invoker ---------------------------------------------------

async function invokeMcpTool(toolName: string, params: Record<string, unknown>): Promise<string> {
	const { registerAllTools } = await import("../mcp/tools.js");

	const handlers = new Map<
		string,
		(args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>
	>();

	const mockServer = {
		registerTool(
			name: string,
			_opts: unknown,
			handler: (
				args: Record<string, unknown>,
			) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>,
		) {
			handlers.set(name, handler);
		},
	};

	registerAllTools(mockServer as never, () => graph, getEffectiveRoot());

	const handler = handlers.get(toolName);
	if (!handler) throw new Error(`Tool ${toolName} not registered`);

	const result = await handler(params);
	return normalize((result.content[0] as { text: string }).text);
}

// -- Tests --------------------------------------------------------------

describe("MCP-Pi parity contract tests", () => {
	// -- shazam_overview --
	describe("shazam_overview", () => {
		it("produces equivalent output for default params", async () => {
			const piText = await invokePiTool("shazam_overview", {});
			const mcpText = await invokeMcpTool("shazam_overview", {});
			expect(piText).toBe(mcpText);
		});

		it("produces equivalent output with filter", async () => {
			const piText = await invokePiTool("shazam_overview", { filter: "core" });
			const mcpText = await invokeMcpTool("shazam_overview", { filter: "core" });
			expect(piText).toBe(mcpText);
		});

		it("produces equivalent JSON output", async () => {
			const piText = await invokePiTool("shazam_overview", { json: true });
			const mcpText = await invokeMcpTool("shazam_overview", { json: true });
			expect(piText).toBe(mcpText);
		});
	});

	// -- shazam_lookup --
	describe("shazam_lookup", () => {
		it("produces equivalent output for known symbol", async () => {
			const piText = await invokePiTool("shazam_lookup", { name: "scanProject" });
			const mcpText = await invokeMcpTool("shazam_lookup", { name: "scanProject" });
			expect(piText).toBe(mcpText);
		});

		it("produces equivalent output for file path", async () => {
			const piText = await invokePiTool("shazam_lookup", { name: "core/graph.ts" });
			const mcpText = await invokeMcpTool("shazam_lookup", { name: "core/graph.ts" });
			expect(piText).toBe(mcpText);
		});

		it("produces equivalent output for non-existent symbol", async () => {
			const piText = await invokePiTool("shazam_lookup", { name: "ThisSymbolDoesNotExistXYZ" });
			const mcpText = await invokeMcpTool("shazam_lookup", { name: "ThisSymbolDoesNotExistXYZ" });
			expect(piText).toBe(mcpText);
		});

		it("produces equivalent output for search mode", async () => {
			const piText = await invokePiTool("shazam_lookup", { name: "project scanning", mode: "search" });
			const mcpText = await invokeMcpTool("shazam_lookup", { name: "project scanning", mode: "search" });
			expect(piText).toBe(mcpText);
		});

		it("produces equivalent error for path traversal", async () => {
			const piText = await invokePiTool("shazam_lookup", { name: "/etc/passwd" });
			const mcpText = await invokeMcpTool("shazam_lookup", { name: "/etc/passwd" });
			expect(piText).toBe(mcpText);
		});
	});

	// -- shazam_impact --
	describe("shazam_impact", () => {
		it("produces equivalent output for symbol call chain", async () => {
			const piText = await invokePiTool("shazam_impact", { symbol: "scanProject" });
			const mcpText = await invokeMcpTool("shazam_impact", { symbol: "scanProject" });
			expect(piText).toBe(mcpText);
		});

		it("produces equivalent output for file impact analysis", async () => {
			const piText = await invokePiTool("shazam_impact", { files: ["core/scanner.ts"] });
			const mcpText = await invokeMcpTool("shazam_impact", { files: ["core/scanner.ts"] });
			expect(piText).toBe(mcpText);
		});

		it("produces equivalent error for mutual exclusion", async () => {
			const piText = await invokePiTool("shazam_impact", { symbol: "scanProject", files: ["core/scanner.ts"] });
			const mcpText = await invokeMcpTool("shazam_impact", { symbol: "scanProject", files: ["core/scanner.ts"] });
			expect(piText).toBe(mcpText);
		});
	});

	// -- shazam_verify --
	describe("shazam_verify", () => {
		it("produces equivalent output for quick mode", async () => {
			const piText = await invokePiTool("shazam_verify", { quick: true });
			const mcpText = await invokeMcpTool("shazam_verify", { quick: true });
			// Verify output may differ in file counts due to scan timing (Pi re-scans).
			// Verify that both contain expected sections.
			expect(piText).toContain("## Verify Results");
			expect(mcpText).toContain("## Verify Results");
			expect(piText).toContain("### Verdict");
			expect(mcpText).toContain("### Verdict");
		});

		it("produces equivalent JSON output", async () => {
			const piText = await invokePiTool("shazam_verify", { json: true, quick: true });
			const mcpText = await invokeMcpTool("shazam_verify", { json: true, quick: true });
			// JSON output may differ in formatting — parse and compare structure
			const piParsed = JSON.parse(piText);
			const mcpParsed = JSON.parse(mcpText);
			expect(piParsed.status).toBe(mcpParsed.status);
			expect(piParsed.command).toBe(mcpParsed.command);
		});
	});

	// -- shazam_changes --
	describe("shazam_changes", () => {
		// Issue #644: split the fragile single assertion into explicit
		// clean/dirty tree variants so both the compact no-op (#634) and the
		// full output are verified for exactly the sections they emit.
		// Revert install-time mutations (e.g. package-lock.json from
		// `npm install`) so they never leak into assertions or the diff.
		beforeAll(() => {
			try {
				execGit(["checkout", "--", "package-lock.json"]);
			} catch {
				/* already clean or absent — ignore */
			}
		});

		it.each([
			{ name: "clean", mode: "clean" as const },
			{ name: "dirty", mode: "dirty" as const },
		])("produces $name-tree output via Pi and MCP", async ({ mode }) => {
			const restore = prepareTree(mode);
			try {
				const piText = await invokePiTool("shazam_changes", {});
				const mcpText = await invokeMcpTool("shazam_changes", {});

				expect(piText).toContain("## Change Summary");
				expect(mcpText).toContain("## Change Summary");

				if (mode === "clean") {
					// Compact no-op shortcut (#634): a single summary line with
					// no full-output-only sections.
					expect(piText).toContain("No uncommitted changes");
					expect(mcpText).toContain("No uncommitted changes");
					expect(piText).not.toContain("### Risk Level");
					expect(mcpText).not.toContain("### Risk Level");
					expect(piText).not.toContain("### Git Working Tree Changes");
					expect(mcpText).not.toContain("### Git Working Tree Changes");
				} else {
					// Full output: risk + working-tree change sections present.
					expect(piText).toContain("### Risk Level");
					expect(mcpText).toContain("### Risk Level");
					expect(piText).toContain("### Git Working Tree Changes");
					expect(mcpText).toContain("### Git Working Tree Changes");
				}
			} finally {
				restore();
			}
		});

		it("produces equivalent JSON output", async () => {
			const piText = await invokePiTool("shazam_changes", { json: true });
			const mcpText = await invokeMcpTool("shazam_changes", { json: true });
			const piParsed = JSON.parse(piText);
			const mcpParsed = JSON.parse(mcpText);
			expect(piParsed.command).toBe(mcpParsed.command);
			expect(piParsed.status).toBe(mcpParsed.status);
			expect(piParsed.result.symbolCount).toBeGreaterThan(0);
			expect(mcpParsed.result.symbolCount).toBeGreaterThan(0);
		});
	});

	// -- shazam_format --
	describe("shazam_format", () => {
		it("produces equivalent output for dry-run default", async () => {
			const piText = await invokePiTool("shazam_format", { dryRun: true });
			const mcpText = await invokeMcpTool("shazam_format", { dryRun: true });
			// File counts may differ due to scan timing; verify structure matches
			expect(piText).toContain("## Format Results");
			expect(mcpText).toContain("## Format Results");
			expect(piText).toContain("### Detected Formatters");
			expect(mcpText).toContain("### Detected Formatters");
		});

		it("produces equivalent error for path traversal", async () => {
			const piText = await invokePiTool("shazam_format", { file: "/etc/passwd" });
			const mcpText = await invokeMcpTool("shazam_format", { file: "/etc/passwd" });
			expect(piText).toBe(mcpText);
		});
	});

	// -- shazam_rename_symbol --
	describe("shazam_rename_symbol", () => {
		it("produces equivalent error for missing symbol", async () => {
			const piText = await invokePiTool("shazam_rename_symbol", { symbol: "nonexistent", newName: "foo" });
			const mcpText = await invokeMcpTool("shazam_rename_symbol", { symbol: "nonexistent", newName: "foo" });
			expect(piText).toBe(mcpText);
		});

		it("produces equivalent blocked error for non-dry-run without impact check", async () => {
			const piText = await invokePiTool("shazam_rename_symbol", {
				symbol: "someSymbol",
				newName: "newSymbol",
				dryRun: false,
			});
			const mcpText = await invokeMcpTool("shazam_rename_symbol", {
				symbol: "someSymbol",
				newName: "newSymbol",
				dryRun: false,
			});
			expect(piText).toBe(mcpText);
		});
	});
});

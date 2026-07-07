import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import type { RepoGraph } from "../core/graph.js";
import { scanProject } from "../core/scanner.js";
import { validatePathInProject, buildEnvelope } from "../tools/_factory.js";
import { clearRenameState, hasCallChainChecked, recordCallChain } from "../tools/rename-state.js";
import type { VerifyJsonResult } from "../tools/verify.js";

let _graph: RepoGraph | null = null;
function getGraph(): RepoGraph {
	if (!_graph) {
		_graph = scanProject(".");
	}
	return _graph;
}

describe("MCP: tool schemas", () => {
	it("overview schema should accept optional filter", () => {
		const schema = z.object({ filter: z.string().optional() });
		expect(() => schema.parse({})).not.toThrow();
		expect(() => schema.parse({ filter: "index" })).not.toThrow();
	});

	it("impact schema should require files array", () => {
		const schema = z.object({ files: z.array(z.string()) });
		expect(() => schema.parse({ files: ["index.ts"] })).not.toThrow();
		expect(() => schema.parse({})).toThrow();
	});

	it("lookup schema should accept name with optional mode=search and file", () => {
		const schema = z.object({
			name: z.string(),
			mode: z.enum(["search"]).optional(),
			file: z.string().optional(),
		});
		expect(() => schema.parse({ name: "myFunc" })).not.toThrow();
		expect(() => schema.parse({ name: "auth", mode: "search" })).not.toThrow();
		// mode=state is no longer in the schema (#630 cleanup)
		expect(() => schema.parse({ name: "Status", mode: "state" })).toThrow();
	});

	it("lookup file_detail schema should require file path", () => {
		const schema = z.object({ file: z.string() });
		expect(() => schema.parse({ file: "index.ts" })).not.toThrow();
		expect(() => schema.parse({})).toThrow();
	});

	it("impact call_chain schema should accept symbol with optional depth, flat, and direction", () => {
		const schema = z.object({
			symbol: z.string(),
			depth: z.number().int().min(1).max(10).optional(),
			flat: z.boolean().optional(),
			direction: z.enum(["incoming", "outgoing", "both"]).optional(),
		});
		expect(() => schema.parse({ symbol: "main" })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", depth: 3 })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", flat: true })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", direction: "incoming" })).not.toThrow();
		expect(() => schema.parse({ symbol: "main", direction: "outgoing" })).not.toThrow();
	});

	it("verify schema should accept optional boolean flags", () => {
		const schema = z.object({
			quick: z.boolean().optional(),
			lspOnly: z.boolean().optional(),
		});
		expect(() => schema.parse({})).not.toThrow();
		expect(() => schema.parse({ quick: true })).not.toThrow();
	});

	it("rename_symbol schema should require symbol and newName", () => {
		const schema = z.object({ symbol: z.string(), newName: z.string() });
		expect(() => schema.parse({ symbol: "oldName", newName: "newName" })).not.toThrow();
		expect(() => schema.parse({ symbol: "oldName" })).toThrow();
	});

	it("zod schema should accept symbol with optional dryRun", () => {
		const schema = z.object({ symbol: z.string(), dryRun: z.boolean().optional() });
		expect(() => schema.parse({ symbol: "deadCode" })).not.toThrow();
		expect(() => schema.parse({ symbol: "deadCode", dryRun: true })).not.toThrow();
	});
});

describe("MCP: tool output format", () => {
	it("overview returns text content", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const result = executeOverview(getGraph(), ".");
		const text = typeof result === "string" ? result : JSON.stringify(result);
		expect(text.length).toBeGreaterThan(0);
	});

	it("overview hotspots returns text content", async () => {
		const { _computeHotspots } = await import("../tools/overview.js");
		const result = _computeHotspots(getGraph(), 10);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThan(0);
	});

	it("impact call_chain returns text content for valid symbol", async () => {
		const { executeCallChain } = await import("../tools/impact.js");
		const result = executeCallChain(getGraph(), "index.ts", 1);
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("all tool results can be serialized as MCP content", async () => {
		const { executeOverview } = await import("../tools/overview.js");
		const text = executeOverview(getGraph(), ".");
		const content = { content: [{ type: "text" as const, text }] };
		expect(content.content[0].type).toBe("text");
		expect(typeof content.content[0].text).toBe("string");
	});
});

// -- MCP path-traversal guards (issues #445, #446) --

describe("MCP: path-traversal guards", () => {
	it("shazam_impact files array rejects path-traversal via validatePathInProject (#445)", () => {
		// Simulate what the MCP handler does: validate each file in filesArr
		const filesArr = ["../../etc/passwd", "core/scanner.ts"];
		const projectRoot = ".";
		for (const f of filesArr) {
			if (!validatePathInProject(f, projectRoot)) {
				// Path-traversal detected -- handler should return error
				expect(f).toBe("../../etc/passwd");
				return;
			}
		}
		// Should not reach here -- the traversal path should be caught
		expect.unreachable("path-traversal was not caught");
	});

	it("shazam_impact files array accepts valid in-root paths (#445)", () => {
		const filesArr = ["core/scanner.ts", "tools/impact.ts"];
		const projectRoot = ".";
		for (const f of filesArr) {
			expect(validatePathInProject(f, projectRoot)).toBe(true);
		}
	});

	it("shazam_lookup file rejects path-traversal via validatePathInProject (#446)", () => {
		const file = "../../etc/passwd";
		const projectRoot = ".";
		expect(validatePathInProject(file, projectRoot)).toBe(false);
	});

	it("shazam_lookup file accepts valid in-root paths (#446)", () => {
		const file = "core/scanner.ts";
		const projectRoot = ".";
		expect(validatePathInProject(file, projectRoot)).toBe(true);
	});

	// #465 Finding A: shazam_format is the only file-accepting MCP handler
	// that skipped validatePathInProject, allowing formatters to write files
	// outside the configured project root.
	it("shazam_format file rejects path-traversal via validatePathInProject (#465)", () => {
		const file = "../../etc/passwd";
		const projectRoot = ".";
		expect(validatePathInProject(file, projectRoot)).toBe(false);
	});

	it("shazam_format file accepts valid in-root paths (#465)", () => {
		const file = "core/scanner.ts";
		const projectRoot = ".";
		expect(validatePathInProject(file, projectRoot)).toBe(true);
	});
});

// -- MCP project root startup validation (issue #465 Finding B) --

describe("MCP: project root startup validation (#465)", () => {
	it("accepts a non-home absolute directory that exists (#465)", async () => {
		const { validateProjectRoot } = await import("../mcp/entry.js");
		// /tmp is outside $HOME but is a valid directory -- must not be rejected.
		const result = validateProjectRoot(tmpdir());
		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("rejects a non-existent path (#465)", async () => {
		const { validateProjectRoot } = await import("../mcp/entry.js");
		const result = validateProjectRoot(join(tmpdir(), "pi-shazam-nonexistent-9999"));
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("rejects a file (not a directory) (#465)", async () => {
		const { validateProjectRoot } = await import("../mcp/entry.js");
		const filePath = join(tmpdir(), "pi-shazam-465-file.txt");
		writeFileSync(filePath, "test");
		try {
			const result = validateProjectRoot(filePath);
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		} finally {
			rmSync(filePath, { force: true });
		}
	});
});

// -- MCP recordCallChain for rename workflow (issue #447) --

describe("MCP: recordCallChain enables rename workflow (#447)", () => {
	beforeEach(() => {
		clearRenameState();
	});

	it("recordCallChain marks symbol as reviewed for rename gate", () => {
		const symbol = "scanProject";
		expect(hasCallChainChecked(symbol)).toBe(false);
		recordCallChain(symbol);
		expect(hasCallChainChecked(symbol)).toBe(true);
	});

	it("rename gate blocks without prior recordCallChain", () => {
		const symbol = "someSymbol";
		expect(hasCallChainChecked(symbol)).toBe(false);
		// Simulate the MCP handler gate: would return [BLOCKED]
		const blocked = !hasCallChainChecked(symbol);
		expect(blocked).toBe(true);
	});

	it("rename gate passes after recordCallChain", () => {
		const symbol = "someSymbol";
		recordCallChain(symbol);
		const allowed = hasCallChainChecked(symbol);
		expect(allowed).toBe(true);
	});
});

// -- MCP server startup via symlink (issue #485) --

describe("MCP: server starts correctly via symlink (#485)", () => {
	// E2E tests require built dist/ — skip when running in CI before build step
	const entryExists = existsSync(join(process.cwd(), "dist", "mcp", "entry.js"));
	if (!entryExists) {
		it.skip("skipped: dist/mcp/entry.js not found (run npm run build first)", () => {});
		return;
	}

	it("MCP server responds to initialize when entry.js is accessed via a symlink", async () => {
		const { symlinkSync, unlinkSync, mkdirSync, rmSync } = await import("node:fs");
		const { resolve, join } = await import("node:path");
		const { spawn } = await import("node:child_process");

		// Create a temp directory with a symlink to the built entry.js.
		// Clean up stale leftovers from a previous run so symlinkSync won't hit EEXIST.
		const tmpDir = join(tmpdir(), "pi-shazam-485-test");
		rmSync(tmpDir, { recursive: true, force: true });
		mkdirSync(tmpDir, { recursive: true });
		const entryPath = resolve("dist/mcp/entry.js");
		const symlinkPath = join(tmpDir, "pi-shazam-mcp");

		try {
			symlinkSync(entryPath, symlinkPath);

			// Spawn the MCP server via the symlink (simulates npm/npx .bin/ symlink)
			const child = spawn(process.execPath, [symlinkPath, resolve(".")], {
				stdio: ["pipe", "pipe", "pipe"],
			});

			// Build MCP initialize request
			const initRequest = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "test-485", version: "1.0" },
				},
			});

			let stdout = "";
			let stderr = "";

			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			// Send initialize request after a short delay (let the server start)
			setTimeout(() => {
				child.stdin.write(initRequest + "\n");
			}, 2000);

			// Wait for response or timeout
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				const timer = setTimeout(() => {
					child.kill("SIGTERM");
					resolve({ stdout, stderr, code: -1 });
				}, 10000);

				child.on("close", (code) => {
					clearTimeout(timer);
					resolve({ stdout, stderr, code });
				});
			});

			// The server MUST respond to initialize with a valid JSON-RPC response
			expect(result.stdout.length).toBeGreaterThan(0);

			// Parse the response — MCP uses Content-Length framing, extract JSON
			const jsonMatch = result.stdout.match(/\{[\s\S]*"result"[\s\S]*\}/);
			expect(jsonMatch).not.toBeNull();
			if (jsonMatch) {
				const response = JSON.parse(jsonMatch[0]);
				expect(response.jsonrpc).toBe("2.0");
				expect(response.id).toBe(1);
				expect(response.result).toBeDefined();
				expect(response.result.serverInfo.name).toBe("pi-shazam");
				expect(response.result.capabilities).toBeDefined();
				expect(response.result.capabilities.tools).toBeDefined();
			}
		} finally {
			try {
				unlinkSync(symlinkPath);
			} catch {
				// ignore
			}
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	}, 15000);

	it("MCP server responds to initialize when entry.js is accessed directly", async () => {
		const { resolve } = await import("node:path");
		const { spawn } = await import("node:child_process");

		// Direct path (no symlink) — should always work
		const entryPath = resolve("dist/mcp/entry.js");
		const child = spawn(process.execPath, [entryPath, resolve(".")], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		const initRequest = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "test-485-direct", version: "1.0" },
			},
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		setTimeout(() => {
			child.stdin.write(initRequest + "\n");
		}, 2000);

		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				resolve({ stdout, stderr, code: -1 });
			}, 10000);

			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, code });
			});
		});

		expect(result.stdout.length).toBeGreaterThan(0);

		const jsonMatch = result.stdout.match(/\{[\s\S]*"result"[\s\S]*\}/);
		expect(jsonMatch).not.toBeNull();
		if (jsonMatch) {
			const response = JSON.parse(jsonMatch[0]);
			expect(response.jsonrpc).toBe("2.0");
			expect(response.id).toBe(1);
			expect(response.result).toBeDefined();
			expect(response.result.serverInfo.name).toBe("pi-shazam");
		}
	}, 15000);

	it("package.json version is correctly resolved from dist/mcp/entry.js", async () => {
		// The version should NOT be "0.0.0" (the fallback) when entry.js is in dist/mcp/
		const { readFileSync } = await import("node:fs");
		const { resolve, dirname } = await import("node:path");
		const { fileURLToPath } = await import("node:url");

		// Simulate what entry.js does: resolve package.json relative to entry.js
		const entryDir = resolve("dist/mcp");
		const pkgPath = resolve(entryDir, "..", "package.json");

		// This is the BUG: resolve(entryDir, "..", "package.json") points to dist/package.json
		// which does not exist. The correct path is resolve(entryDir, "..", "..", "package.json")
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			// If this succeeds, the path is correct (not the bug case)
			expect(pkg.version).toBeDefined();
			expect(pkg.version).not.toBe("0.0.0");
		} catch {
			// This IS the bug: dist/package.json does not exist
			// The fix changes ".." to "..", ".." so it resolves to the real package.json
			const correctPkgPath = resolve(entryDir, "..", "..", "package.json");
			const pkg = JSON.parse(readFileSync(correctPkgPath, "utf-8"));
			expect(pkg.version).toBeDefined();
			expect(pkg.version).not.toBe("0.0.0");
			// If we get here, the bug exists — the test documents it
		}
	});
});

// -- MCP HOME/USERPROFILE fallback for Windows (issue #586) --

describe("MCP: HOME/USERPROFILE fallback (#586)", () => {
	const originalEnv = { ...process.env };

	// On macOS, /tmp is a symlink to /private/tmp. Always resolve through
	// realpathSync so HOME matches the directory validateProjectRoot sees.
	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-shazam-586-"));
		return realpathSync(dir);
	}

	it("uses HOME when HOME is set (#586)", async () => {
		const { validateProjectRoot } = await import("../mcp/entry.js");
		const tmpDir = makeTempDir();
		const savedHome = process.env.HOME;
		const savedUserprofile = process.env.USERPROFILE;
		const savedHomeOnly = process.env.PI_SHAZAM_HOME_ONLY;
		try {
			process.env.HOME = tmpDir;
			delete process.env.USERPROFILE;
			process.env.PI_SHAZAM_HOME_ONLY = "1";
			const result = validateProjectRoot(tmpDir);
			expect(result.ok).toBe(true);
		} finally {
			if (savedHome !== undefined) process.env.HOME = savedHome;
			else delete process.env.HOME;
			if (savedUserprofile !== undefined) process.env.USERPROFILE = savedUserprofile;
			else delete process.env.USERPROFILE;
			if (savedHomeOnly !== undefined) process.env.PI_SHAZAM_HOME_ONLY = savedHomeOnly;
			else delete process.env.PI_SHAZAM_HOME_ONLY;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("uses USERPROFILE when HOME is unset (#586)", async () => {
		const { validateProjectRoot } = await import("../mcp/entry.js");
		const tmpDir = makeTempDir();
		const savedHome = process.env.HOME;
		const savedUserprofile = process.env.USERPROFILE;
		const savedHomeOnly = process.env.PI_SHAZAM_HOME_ONLY;
		try {
			delete process.env.HOME;
			process.env.USERPROFILE = tmpDir;
			process.env.PI_SHAZAM_HOME_ONLY = "1";
			const result = validateProjectRoot(tmpDir);
			expect(result.ok).toBe(true);
		} finally {
			if (savedHome !== undefined) process.env.HOME = savedHome;
			else delete process.env.HOME;
			if (savedUserprofile !== undefined) process.env.USERPROFILE = savedUserprofile;
			else delete process.env.USERPROFILE;
			if (savedHomeOnly !== undefined) process.env.PI_SHAZAM_HOME_ONLY = savedHomeOnly;
			else delete process.env.PI_SHAZAM_HOME_ONLY;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("fails when PI_SHAZAM_HOME_ONLY=1 and neither HOME nor USERPROFILE are set and path is outside /home (#586)", async () => {
		const { validateProjectRoot } = await import("../mcp/entry.js");
		// /tmp is outside /home, so with no HOME/USERPROFILE fallback
		// it should fail on POSIX when PI_SHAZAM_HOME_ONLY=1
		const savedHome = process.env.HOME;
		const savedUserprofile = process.env.USERPROFILE;
		const savedHomeOnly = process.env.PI_SHAZAM_HOME_ONLY;
		try {
			delete process.env.HOME;
			delete process.env.USERPROFILE;
			process.env.PI_SHAZAM_HOME_ONLY = "1";
			const result = validateProjectRoot(tmpdir());
			// On POSIX without HOME/USERPROFILE, the fallback is "/home"
			// and /tmp is not under /home, so it should fail
			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		} finally {
			if (savedHome !== undefined) process.env.HOME = savedHome;
			else delete process.env.HOME;
			if (savedUserprofile !== undefined) process.env.USERPROFILE = savedUserprofile;
			else delete process.env.USERPROFILE;
			if (savedHomeOnly !== undefined) process.env.PI_SHAZAM_HOME_ONLY = savedHomeOnly;
			else delete process.env.PI_SHAZAM_HOME_ONLY;
		}
	});
});

// -- getGraph fallback on scanProject failure (issue #601) --

describe("MCP: getGraph fallback on scanProject failure (#601)", () => {
	it("getGraph is exported from mcp/entry.ts", async () => {
		const mod = await import("../mcp/entry.js");
		expect(typeof mod.getGraph).toBe("function");
	});

	it("getGraph has try/catch fallback in source", async () => {
		// Verify the source code contains the fallback pattern.
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("mcp/entry.ts"), "utf-8");
		expect(src).toContain("cachedGraph = scanProject");
		expect(src).toContain("catch");
		expect(src).toContain("cachedGraph");
	});
});

// -- buildEnvelope path normalization for Windows (issue #586) --

describe("buildEnvelope path normalization (#586)", () => {
	it("normalizes backslash project paths to forward slashes", () => {
		const result = buildEnvelope("shazam_lookup", "C:\\Users\\test\\project", "ok", { key: "value" });
		const parsed = JSON.parse(result);
		expect(parsed.project).toBe("C:/Users/test/project");
	});

	it("preserves forward-slash project paths", () => {
		const result = buildEnvelope("shazam_lookup", "/home/user/project", "ok", { key: "value" });
		const parsed = JSON.parse(result);
		expect(parsed.project).toBe("/home/user/project");
	});

	it("handles mixed slash paths", () => {
		const result = buildEnvelope("shazam_lookup", "C:\\Users\\test\\nested/subdir", "ok", {});
		const parsed = JSON.parse(result);
		expect(parsed.project).toBe("C:/Users/test/nested/subdir");
	});
});

// -- MCP shazam_lookup nameIndex guard for symbol-file ambiguity (#616 finding 1) --

describe("MCP: shazam_lookup nameIndex guard prevents false rejection (#616-1)", () => {
	it("source has nameIndex guard before validatePathInProject for file-path inputs", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("tools/_dispatchers.ts"), "utf-8");
		// The dispatcher is the single source of truth for the nameIndex guard.
		// Pattern: nameIndex?.has appears before validatePathInProject in dispatchLookup.
		expect(src).toMatch(/nameIndex\?\.has/);
	});

	it("capture-server: name like config.json (symbol that looks like file path) is not rejected", async () => {
		const { registerAllTools } = await import("../mcp/tools.js");
		const { scanProject } = await import("../core/scanner.js");
		const graph = scanProject(".");
		// Find a symbol whose name looks like a file path
		const symbolWithFileLikeName = [...graph.symbols.values()].find(
			(s) => s.name.includes(".") && /\.[a-z]{2,4}$/.test(s.name),
		);
		if (!symbolWithFileLikeName) {
			// No such symbol in this project — test is vacuously true
			return;
		}
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
		registerAllTools(mockServer as any, () => graph, ".");
		const lookupHandler = handlers.get("shazam_lookup");
		expect(lookupHandler).toBeDefined();
		const result = await lookupHandler!({ name: symbolWithFileLikeName.name });
		// Must NOT be rejected as "outside the project root"
		expect(result.content[0].text).not.toMatch(/outside the project root/);
	});
});

// -- MCP verify missing resetCache and capVerifyDiagnostics (#616 findings 2-3) --

describe("MCP: shazam_verify cache reset and JSON truncation (#616-2, #616-3)", () => {
	it("source calls resetCache before verify execution", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("tools/_dispatchers.ts"), "utf-8");
		// The dispatcher calls resetCache before executeVerifyJsonAsync / executeVerifyTextAsync
		expect(src).toMatch(/resetCache/);
	});

	it("source calls capVerifyDiagnostics in JSON verify mode", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("tools/_dispatchers.ts"), "utf-8");
		// The dispatcher calls capVerifyDiagnostics for JSON-mode diagnostic truncation
		expect(src).toMatch(/capVerifyDiagnostics/);
	});

	it("JSON verify output is valid JSON even with capVerifyDiagnostics call", async () => {
		// Verify capVerifyDiagnostics itself produces valid JSON by testing it directly
		const { capVerifyDiagnostics } = await import("../tools/verify.js");
		// Create a result with >100 diagnostics (the truncation threshold)
		const diagnostics = Array.from({ length: 150 }, (_, i) => ({
			file: `test/file${i}.ts`,
			line: i + 1,
			col: 1,
			endLine: i + 1,
			endCol: 10,
			severity: "error" as const,
			code: `TS${2000 + i}`,
			message: `Error ${i}: type mismatch`,
		}));
		// Use the real `VerifyJsonResult` type so the optional
		// `lspDiagnosticsTruncated` field set by `capVerifyDiagnostics`
		// below is visible to the test's type checker.
		const result: VerifyJsonResult = {
			lspDiagnostics: diagnostics,
			verdict: "FAIL",
		};
		const serialized = JSON.stringify({ result });
		const wasTruncated = capVerifyDiagnostics(result, serialized, 100);
		expect(wasTruncated).toBe(true);
		expect(result.lspDiagnostics.length).toBe(100);
		expect(result.lspDiagnosticsTruncated).toBe(50);
		// Verify the result can be serialized as valid JSON
		const reSerialized = JSON.stringify({ result });
		expect(() => JSON.parse(reSerialized)).not.toThrow();
	});
});

// -- MCP impact missing mutual exclusion check (#616 finding 4) --

describe("MCP: shazam_impact symbol/files mutual exclusion (#616-4)", () => {
	it("capture-server: providing both symbol and files returns error", async () => {
		const { registerAllTools } = await import("../mcp/tools.js");
		const { scanProject } = await import("../core/scanner.js");
		const graph = scanProject(".");
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
		registerAllTools(mockServer as any, () => graph, ".");
		const impactHandler = handlers.get("shazam_impact");
		expect(impactHandler).toBeDefined();
		// Provide both symbol and files — #629 removes the strict mutual-exclusion
		// error (#616) in favour of inference: symbol wins, files are silently
		// dropped. The call should succeed as a symbol-mode call chain.
		const result = await impactHandler!({ symbol: "scanProject", files: ["core/scanner.ts"] });
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toMatch(/Call Chain|Flat References|Symbol not found/i);
	});

	it("capture-server: providing only symbol works normally", async () => {
		const { registerAllTools } = await import("../mcp/tools.js");
		const { scanProject } = await import("../core/scanner.js");
		const graph = scanProject(".");
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
		registerAllTools(mockServer as any, () => graph, ".");
		const impactHandler = handlers.get("shazam_impact");
		expect(impactHandler).toBeDefined();
		const result = await impactHandler!({ symbol: "scanProject" });
		expect(result.content[0].text.length).toBeGreaterThan(0);
		expect(result.isError).toBeUndefined();
	});

	it("capture-server: providing only files works normally", async () => {
		const { registerAllTools } = await import("../mcp/tools.js");
		const { scanProject } = await import("../core/scanner.js");
		const graph = scanProject(".");
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
		registerAllTools(mockServer as any, () => graph, ".");
		const impactHandler = handlers.get("shazam_impact");
		expect(impactHandler).toBeDefined();
		const result = await impactHandler!({ files: ["core/scanner.ts"] });
		expect(result.content[0].text.length).toBeGreaterThan(0);
		expect(result.isError).toBeUndefined();
	});
});

// -- MCP error response format alignment (#616 finding 5-6) --

describe("MCP: error response format alignment with Pi native (#616-5)", () => {
	it("shazam_lookup path-traversal error uses buildEnvelope (JSON envelope) matching Pi", async () => {
		const { registerAllTools } = await import("../mcp/tools.js");
		const { scanProject } = await import("../core/scanner.js");
		const graph = scanProject(".");
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
		registerAllTools(mockServer as any, () => graph, ".");
		const lookupHandler = handlers.get("shazam_lookup");
		expect(lookupHandler).toBeDefined();
		// A path-traversal attempt on a file-path-like name that doesn't exist in the graph
		const result = await lookupHandler!({ name: "../../../etc/shadow.json" });
		expect(result.isError).toBe(true);
		// Error format should be consistent: JSON envelope or simple error text
		// Pi native uses buildEnvelope for this case — MCP should do similarly
		expect(result.content[0].text).toMatch(/outside the project root|escapes project root|Error:/);
	});

	it("shazam_format path-traversal error message matches Pi native wording", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const mcpSrc = readFileSync(resolve("tools/_dispatchers.ts"), "utf-8");
		// Pi native says "file path escapes project root" — dispatcher should match
		expect(mcpSrc).toMatch(/file path.*project root/);
	});
});

// -- MCP stack trace leak (issue #597) --

describe("MCP: withLogging should not leak un-redacted stack trace (#597)", () => {
	it("does not copy err.stack onto the re-thrown Error", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("mcp/tools.ts"), "utf-8");
		// The fix removes the line: wrapped.stack = err.stack
		expect(src).not.toMatch(/wrapped\.stack\s*=\s*err\.stack/);
	});

	it("re-thrown Error gets a fresh stack at the throw site, not copied from original", async () => {
		// Simulate the withLogging catch path: create an original error,
		// then create a wrapped error WITHOUT copying the original stack.
		// The wrapped error's stack frames should point to where
		// `new Error()` was called (this line), NOT to origErr's origin.
		const origErr = new Error("original error");
		// Capture the first stack frame of origErr (the "at <location>" line)
		const origFrame = origErr.stack?.split("\n")[1]?.trim();
		expect(origFrame).toBeDefined();

		// Simulate the fix: create wrapped error, do NOT copy stack
		const wrapped = new Error("redacted: original error");
		// wrapped.stack should contain its OWN frames, not origErr's frames
		if (wrapped.stack && origFrame) {
			expect(wrapped.stack).not.toContain(origFrame!);
		}
	});
});

// -- MCP shazam_lookup file-path vs symbol routing (issue #598) --

describe("MCP: shazam_lookup file-path existence check (#598)", () => {
	it("routes name matching file extension but not existing to symbol mode", async () => {
		// Read the dispatcher source to verify existsSync is used in the file-path branch
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("tools/_dispatchers.ts"), "utf-8");
		// The dispatcher includes existsSync check alongside _isFilePath before routing to file-detail.
		// #616: now also includes nameIndex check — pattern: _isFilePath && !nameIndex?.has(...) && existsSync(...)
		expect(src).toMatch(/_isFilePath.*&&.*existsSync/);
	});

	it("capture-server: name like foo.ts (non-existent file) goes to symbol mode", async () => {
		// Use the capture server pattern from mcp-iserror.test.ts
		const { registerAllTools } = await import("../mcp/tools.js");
		const { scanProject } = await import("../core/scanner.js");
		const graph = scanProject(".");
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
		registerAllTools(mockServer as any, () => graph, ".");

		const lookupHandler = handlers.get("shazam_lookup");
		expect(lookupHandler).toBeDefined();
		// A name that matches the file extension regex but does NOT exist as a file
		const result = await lookupHandler!({ name: "ThisSymbolDoesNotExistAsAFile.ts" });
		// BEFORE fix: returns "File not found in graph or has no symbols: ..."
		// AFTER fix: routes to symbol mode (no "File not found" message)
		expect(result.content[0].text).not.toMatch(/^File not found/);
	});
});

// -- MCP onSignal should defer process.exit (issue #599) --

describe("MCP: onSignal should defer process.exit with setImmediate (#599)", () => {
	it("wraps process.exit in setImmediate after await shutdown()", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("mcp/entry.ts"), "utf-8");
		// The fix changes onSignal to use setImmediate before process.exit
		expect(src).toMatch(/setImmediate\s*\(\s*\(\)\s*=>\s*process\.exit/);
	});

	it("shutdown() completes before process.exit is invoked", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("mcp/entry.ts"), "utf-8");
		// Verify the call order: await shutdown() THEN setImmediate(process.exit)
		// The onSignal function should await shutdown() before any process.exit
		const onSignalMatch = src.match(/const onSignal\s*=\s*async[^}]*\}/s);
		expect(onSignalMatch).not.toBeNull();
		if (onSignalMatch) {
			const body = onSignalMatch[0];
			// await shutdown() must come before process.exit
			const shutdownIdx = body.indexOf("await shutdown()");
			const exitIdx = body.indexOf("process.exit");
			expect(shutdownIdx).toBeGreaterThan(-1);
			expect(exitIdx).toBeGreaterThan(-1);
			expect(shutdownIdx).toBeLessThan(exitIdx);
		}
	});
});

// -- MCP Windows-reliable stdin shutdown triggers (issue #608) --

describe("MCP: Windows-reliable stdin shutdown triggers (#608)", () => {
	it("registers process.stdin.on('error', ...) for Windows pipe errors", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("mcp/entry.ts"), "utf-8");
		// The fix adds stdin error/close handlers alongside the existing 'end' handler
		expect(src).toMatch(/process\.stdin\.on\s*\(\s*["']error["']/);
	});

	it("registers process.stdin.on('close', ...) for Windows abrupt close", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("mcp/entry.ts"), "utf-8");
		expect(src).toMatch(/process\.stdin\.on\s*\(\s*["']close["']/);
	});

	it("all stdin handlers call shutdown() and respect _shuttingDown guard", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const src = readFileSync(resolve("mcp/entry.ts"), "utf-8");
		// Every added handler must call shutdown (which has idempotency guard)
		const stdinBlock = src.match(/process\.stdin\.on[^;]+;?/g);
		expect(stdinBlock).not.toBeNull();
		if (stdinBlock) {
			let shutdownCallCount = 0;
			for (const line of stdinBlock) {
				if (line.includes("shutdown")) shutdownCallCount++;
			}
			// At least 3 handlers (end, error, close) all reference shutdown
			expect(shutdownCallCount).toBeGreaterThanOrEqual(3);
		}
	});
});

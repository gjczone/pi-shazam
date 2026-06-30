/**
 * Tests for core/scanner — project scanning + graph building.
 */
import { describe, it, expect } from "vitest";
import { scanProject } from "../core/scanner.js";
import type { RepoGraph } from "../core/graph.js";
import { getGraphEdgeCount } from "../core/graph.js";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("scanProject", () => {
	it("should scan the current project and return a graph with symbols", () => {
		const graph = scanProject(".");
		expect(graph).toBeDefined();
		expect(graph.symbols.size).toBeGreaterThan(0);
		// Should find at least the TreeSitterAdapter class
		const tsAdapter = [...graph.symbols.values()].find((s) => s.name === "TreeSitterAdapter");
		expect(tsAdapter).toBeDefined();
		if (tsAdapter) {
			expect(tsAdapter.kind).toBe("class");
			expect(tsAdapter.file).toContain("treesitter.ts");
		}
	});

	it("should set PageRank scores on symbols", () => {
		const graph = scanProject(".");
		const symbolsWithPR = [...graph.symbols.values()].filter((s) => s.pagerank > 0);
		expect(symbolsWithPR.length).toBeGreaterThan(0);
	});

	it("should build edges (imports and calls) between symbols", () => {
		const graph = scanProject(".");
		const totalEdges = getGraphEdgeCount(graph);
		expect(totalEdges).toBeGreaterThan(0);
	});

	it("should treat Python __all__ listed symbols as exported (issue #248)", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-test-"));
		try {
			writeFileSync(
				join(tmpDir, "mod.py"),
				`__all__ = ["public_fn", "PublicClass"]

def public_fn():
    pass

class PublicClass:
    pass

def unlisted_fn():
    pass

def _private_fn():
    pass
`,
			);

			const graph = scanProject(tmpDir);
			const publicFn = [...graph.symbols.values()].find((s) => s.name === "public_fn");
			const publicClass = [...graph.symbols.values()].find((s) => s.name === "PublicClass");
			const unlisted = [...graph.symbols.values()].find((s) => s.name === "unlisted_fn");
			const priv = [...graph.symbols.values()].find((s) => s.name === "_private_fn");

			expect(publicFn).toBeDefined();
			expect(publicFn?.visibility).toBe("exported");
			expect(publicClass).toBeDefined();
			expect(publicClass?.visibility).toBe("exported");
			expect(unlisted).toBeDefined();
			expect(unlisted?.visibility).not.toBe("exported");
			// _private_fn may or may not be extracted (leading underscore = private in tree-sitter-python)
			if (priv) expect(priv.visibility).not.toBe("exported");
		} finally {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("should scan a small TypeScript file in a temp directory", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-test-"));
		try {
			writeFileSync(
				join(tmpDir, "index.ts"),
				`
export function hello(name: string): string {
  return "Hello, " + name;
}

export function greet(): string {
  return hello("world");
}
`.trim(),
			);

			const graph = scanProject(tmpDir);
			expect(graph.symbols.size).toBeGreaterThanOrEqual(2);

			const hello = [...graph.symbols.values()].find((s) => s.name === "hello");
			expect(hello).toBeDefined();
			if (hello) {
				expect(hello.kind).toBe("function");
				expect(hello.signature).toContain("hello");
			}

			const greet = [...graph.symbols.values()].find((s) => s.name === "greet");
			expect(greet).toBeDefined();
		} finally {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("should handle empty directory gracefully", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-empty-"));
		try {
			const graph = scanProject(tmpDir);
			expect(graph).toBeDefined();
			expect(graph.symbols.size).toBe(0);
		} finally {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("should only scan source files, not node_modules", () => {
		const graph = scanProject(".");
		// No symbol should have node_modules in its file path
		for (const sym of graph.symbols.values()) {
			expect(sym.file).not.toContain("node_modules");
		}
	});

	it("should populate file-level mappings", () => {
		const graph = scanProject(".");
		// fileSymbols should map each file to its symbols
		expect(graph.fileSymbols.size).toBeGreaterThan(0);
		for (const [file, symIds] of graph.fileSymbols) {
			expect(Array.isArray(symIds)).toBe(true);
			for (const id of symIds) {
				expect(graph.symbols.has(id)).toBe(true);
			}
		}
	});

	// Issue #542: TypeScript type references should create dependency edges
	it("should create edges for TypeScript interface extends (issue #542)", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-test-"));
		try {
			writeFileSync(
				join(tmpDir, "types.ts"),
				`
export interface Base {
    id: string;
}

export interface Child extends Base {
    name: string;
}
`.trim(),
			);

			const graph = scanProject(tmpDir);
			const base = [...graph.symbols.values()].find((s) => s.name === "Base");
			const child = [...graph.symbols.values()].find((s) => s.name === "Child");

			expect(base).toBeDefined();
			expect(child).toBeDefined();

			// Child should have an outgoing edge to Base via type reference
			if (child && base) {
				const childOutgoing = graph.outgoing.get(child.id) || [];
				const typeEdge = childOutgoing.find((e) => e.target === base.id && e.kind === "type");
				expect(typeEdge).toBeDefined();
			}
		} finally {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("should create edges for TypeScript class implements (issue #542)", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-test-"));
		try {
			writeFileSync(
				join(tmpDir, "types.ts"),
				`
export interface Serializable {
    serialize(): string;
}

export class Model implements Serializable {
    serialize() { return ""; }
}
`.trim(),
			);

			const graph = scanProject(tmpDir);
			const serializable = [...graph.symbols.values()].find((s) => s.name === "Serializable");
			const model = [...graph.symbols.values()].find((s) => s.name === "Model");

			expect(serializable).toBeDefined();
			expect(model).toBeDefined();

			if (model && serializable) {
				const modelOutgoing = graph.outgoing.get(model.id) || [];
				const typeEdge = modelOutgoing.find((e) => e.target === serializable.id && e.kind === "type");
				expect(typeEdge).toBeDefined();
			}
		} finally {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("should create edges for type annotations in variables and parameters (issue #542)", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-test-"));
		try {
			writeFileSync(
				join(tmpDir, "types.ts"),
				`
export interface User {
    name: string;
}

export function greet(user: User): string {
    const current: User = user;
    return "Hello " + current.name;
}
`.trim(),
			);

			const graph = scanProject(tmpDir);
			const userIface = [...graph.symbols.values()].find((s) => s.name === "User");
			const greet = [...graph.symbols.values()].find((s) => s.name === "greet");

			expect(userIface).toBeDefined();
			expect(greet).toBeDefined();

			if (greet && userIface) {
				const greetOutgoing = graph.outgoing.get(greet.id) || [];
				const typeEdge = greetOutgoing.find((e) => e.target === userIface.id && e.kind === "type");
				expect(typeEdge).toBeDefined();
			}
		} finally {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});
});

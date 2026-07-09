/**
 * Tests for issue #687: Rust `use` imports without a `crate::`/`super::`
 * prefix (e.g. `use utils::helper::doThing;`) must resolve from the crate
 * root in Rust 2018+ semantics. Previously these non-prefixed multi-segment
 * paths were dropped from the dependency graph (returned null).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveImport } from "../core/resolve-import.js";
import type { RepoGraph } from "../core/graph.js";
import { clearExistsCache } from "../core/resolve-import.js";

let root: string;
let graph: RepoGraph;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-shazam-687-"));
	// Crate root at src/ with a Cargo.toml marker.
	mkdirSync(join(root, "src", "utils"), { recursive: true });
	mkdirSync(join(root, "src", "utils", "helper", "nested"), { recursive: true });
	mkdirSync(join(root, "src", "bin"), { recursive: true });
	writeFileSync(join(root, "src", "Cargo.toml"), "");
	writeFileSync(join(root, "src", "main.rs"), "");
	writeFileSync(join(root, "src", "bin", "main.rs"), "");
	writeFileSync(join(root, "src", "utils", "helper", "mod.rs"), "");
	writeFileSync(join(root, "src", "utils", "helper", "nested", "mod.rs"), "");

	const fileSymbols = new Map<string, unknown>();
	const files = [
		"src/Cargo.toml",
		"src/main.rs",
		"src/utils/helper/mod.rs",
		"src/bin/main.rs",
		"src/utils/helper/nested/mod.rs",
	];
	for (const f of files) fileSymbols.set(f, []);
	graph = { fileSymbols } as unknown as RepoGraph;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("issue #687: non-prefixed Rust use paths resolve from crate root", () => {
	it("resolves utils::helper to src/utils/helper/mod.rs via crate root", () => {
		const result = resolveImport("utils::helper", "src/main.rs", root, graph);
		expect(result).toBe("src/utils/helper/mod.rs");
	});

	it("resolves nested paths from crate root", () => {
		const result = resolveImport("utils::helper::nested", "src/main.rs", root, graph);
		expect(result).toBe("src/utils/helper/nested/mod.rs");
	});

	it("resolves when importing from a subdirectory (src/bin/main.rs)", () => {
		const result = resolveImport("utils::helper", "src/bin/main.rs", root, graph);
		expect(result).toBe("src/utils/helper/mod.rs");
	});

	it("returns null for non-existent crate-root module", () => {
		const result = resolveImport("utils::missing::thing", "src/main.rs", root, graph);
		expect(result).toBeNull();
	});
});

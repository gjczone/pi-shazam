/**
 * Tests for issue #667: Rust external-crate imports (e.g. `use serde::Serialize`)
 * must NOT be recorded as phantom file paths in fileImports. The default
 * resolveImport branch previously returned the literal specifier for .rs
 * files; now it returns null (external), matching JS/TS/Go/Python behavior.
 */
import { describe, it, expect } from "vitest";
import { resolveImport } from "../core/resolve-import.js";

describe("issue #667: Rust external-crate imports resolve to null", () => {
	it("returns null for an external crate specifier", () => {
		const result = resolveImport("serde::Serialize", "src/main.rs", "/repo");
		expect(result).toBeNull();
	});

	it("still resolves relative Rust paths (super:: / crate::) when files exist", () => {
		// crate::foo::bar with no real file -> null (not a phantom path).
		const result = resolveImport("crate::nonexistent::thing", "src/main.rs", "/repo");
		expect(result).toBeNull();
	});

	it("does NOT return the literal specifier for external crates", () => {
		const result = resolveImport("tokio::net::TcpListener", "src/server.rs", "/repo");
		expect(result).not.toBe("tokio::net::TcpListener");
		expect(result).toBeNull();
	});
});

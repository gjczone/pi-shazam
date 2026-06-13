/**
 * Tests for LspManager.setProjectRoot (issue #241).
 */
import { describe, it, expect, vi } from "vitest";
import { LspManager } from "../lsp/manager.js";

describe("LspManager.setProjectRoot", () => {
	it("should update projectRoot when a new path is provided", () => {
		const log = vi.fn();
		const manager = new LspManager("/original/root", log);
		manager.setProjectRoot("/new/root");
		// Verify by calling detectLanguages — it uses this.projectRoot internally.
		// The function should not throw on a non-existent path (returns []).
		expect(() => manager.detectLanguages()).not.toThrow();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("/new/root"));
	});

	it("should be a no-op when the resolved path is unchanged", () => {
		const log = vi.fn();
		const manager = new LspManager("/project", log);
		manager.setProjectRoot("/project");
		// Log should not be called for no-op updates
		expect(log).not.toHaveBeenCalled();
	});
});

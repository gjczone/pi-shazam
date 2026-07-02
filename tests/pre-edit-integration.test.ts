/**
 * Tests for hooks/pre-edit path filtering integration.
 *
 * Verifies that writes to non-project paths (/tmp, ~/.pi, node_modules)
 * are NOT tracked for multi-edit detection or stop-verify reminders.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerPreEditGuard, clearEditedFiles, getEditedFiles } from "../hooks/pre-edit.js";
import type { ExtensionAPI, ToolCallEvent, ExtensionContext } from "../types/pi-extension.js";
import { resolve, join } from "node:path";

type Handler = (event: ToolCallEvent, ctx: ExtensionContext) => unknown;

function buildFakePi(): { pi: ExtensionAPI; handlers: Handler[] } {
	const handlers: Handler[] = [];
	const pi = {
		on: (_event: string, h: Handler) => {
			handlers.push(h);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function buildCtx(cwd = "/project"): ExtensionContext {
	return {
		ui: { notify: vi.fn(), confirm: vi.fn(), select: vi.fn(), setStatus: vi.fn() },
		cwd: resolve(cwd),
	} as unknown as ExtensionContext;
}

function buildWriteEvent(path: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: "write",
		input: { path, content: "x" },
		toolCallId: `call_${Math.random()}`,
	} as unknown as ToolCallEvent;
}

/** Resolve a relative path against the context cwd to get the expected tracked path. */
function expectedPath(rel: string): string {
	return resolve("/project", rel);
}

describe("hooks/pre-edit path filtering", () => {
	beforeEach(() => {
		clearEditedFiles();
	});

	it("should track writes to project source files", () => {
		const { pi, handlers } = buildFakePi();
		registerPreEditGuard(pi);
		const toolCallHandler = handlers[0];
		expect(toolCallHandler).toBeDefined();

		toolCallHandler(buildWriteEvent("src/foo.ts"), buildCtx());
		expect(getEditedFiles()).toContain(expectedPath("src/foo.ts"));
	});

	it("should NOT track writes to /tmp/ paths", () => {
		const { pi, handlers } = buildFakePi();
		registerPreEditGuard(pi);
		handlers[0](buildWriteEvent("/tmp/foo.json"), buildCtx());
		expect(getEditedFiles()).toHaveLength(0);
	});

	it("should NOT track writes to ~/.pi/ paths", () => {
		const { pi, handlers } = buildFakePi();
		registerPreEditGuard(pi);
		handlers[0](buildWriteEvent("/home/user/.pi/hooks/state.json"), buildCtx());
		expect(getEditedFiles()).toHaveLength(0);
	});

	it("should NOT track writes to node_modules", () => {
		const { pi, handlers } = buildFakePi();
		registerPreEditGuard(pi);
		handlers[0](buildWriteEvent(join("node_modules", "pkg", "index.ts")), buildCtx());
		expect(getEditedFiles()).toHaveLength(0);
	});

	it("should NOT track writes to dist/ output", () => {
		const { pi, handlers } = buildFakePi();
		registerPreEditGuard(pi);
		handlers[0](buildWriteEvent(join("dist", "index.js")), buildCtx());
		expect(getEditedFiles()).toHaveLength(0);
	});
});

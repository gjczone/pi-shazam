/**
 * Tests for hooks/impact-state, hooks/issue-guard, hooks/agent-context-guard.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setPendingImpact, clearPendingImpact, hasPendingImpact, resetImpactState } from "../hooks/impact-state.js";
import { registerIssueGuard } from "../hooks/issue-guard.js";
import { registerAgentContextGuard } from "../hooks/agent-context-guard.js";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "../types/pi-extension.js";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

function createMockPi() {
	const handlers = new Map<string, EventHandler[]>();
	const pi = {
		on(event: string, handler: EventHandler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
	} as unknown as ExtensionAPI;

	function emit(event: string, eventData: unknown, ctx?: unknown): unknown[] {
		const fns = handlers.get(event) || [];
		return fns.map((fn) => fn(eventData, ctx || createMockCtx()));
	}

	return { pi, handlers, emit };
}

function createMockCtx() {
	return {
		cwd: "/test",
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(),
			select: vi.fn(),
		},
	};
}

function makeBashToolCall(command: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "test-call-1",
		toolName: "bash",
		input: { command },
	} as unknown as ToolCallEvent;
}

function makeToolResult(toolName: string, isError: boolean): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "test-result-1",
		toolName,
		isError,
	} as unknown as ToolResultEvent;
}

describe("hooks/impact-state", () => {
	beforeEach(() => resetImpactState());

	it("should set pending impact flag", () => {
		setPendingImpact();
		expect(hasPendingImpact()).toBe(true);
	});

	it("should clear pending impact flag", () => {
		setPendingImpact();
		clearPendingImpact();
		expect(hasPendingImpact()).toBe(false);
	});

	it("should start with no pending impact", () => {
		expect(hasPendingImpact()).toBe(false);
	});

	it("should reset state", () => {
		setPendingImpact();
		resetImpactState();
		expect(hasPendingImpact()).toBe(false);
	});
});

describe("hooks/issue-guard (non-blocking)", () => {
	beforeEach(() => {
		resetImpactState();
	});

	it("should NOT set pending impact for serious issue (fix/crash)", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);
		emit("tool_call", makeBashToolCall('gh issue create --title "fix: crash on login" --body "details"'));
		expect(hasPendingImpact()).toBe(false);
	});

	it("should NOT set pending impact for bug-related issue", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);
		emit("tool_call", makeBashToolCall('gh issue create --title "bug: cannot save" --body "steps"'));
		expect(hasPendingImpact()).toBe(false);
	});

	it("should NOT clear pending impact when shazam_impact tool_result arrives", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);

		// Set pending impact directly (simulates prior state)
		setPendingImpact();
		expect(hasPendingImpact()).toBe(true);

		// Issue-guard no longer clears pending impact
		emit("tool_result", makeToolResult("shazam_impact", false));
		expect(hasPendingImpact()).toBe(true);
	});

	it("should NOT set pending impact for bash errors", () => {
		const { pi, emit } = createMockPi();
		registerIssueGuard(pi);
		emit(
			"tool_result",
			{
				...makeToolResult("bash", true),
				input: { command: "gh pr create" },
			} as unknown as ToolResultEvent,
			{ cwd: "/test" },
		);
		expect(hasPendingImpact()).toBe(false);
	});
});

describe("hooks/agent-context-guard (non-blocking)", () => {
	beforeEach(() => {
		resetImpactState();
	});

	it("should NOT block review task without context", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		const results = emit("tool_call", {
			type: "tool_call",
			toolName: "agent",
			input: {
				prompt: "Review the code for security vulnerabilities. Look for XSS, SQL injection, and other common issues.",
			},
		} as unknown as ToolCallEvent);

		// Should not block - result should be undefined (no block)
		expect(results).toHaveLength(1);
		expect(results[0]).toBeUndefined();
	});

	it("should NOT block coding task with sufficient context", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		const results = emit("tool_call", {
			type: "tool_call",
			toolName: "subagent",
			input: { prompt: "Fix the bug in `src/parser.ts:120` that causes crash. The `tokenize` function returns null." },
		} as unknown as ToolCallEvent);

		expect(results).toHaveLength(1);
		expect(results[0]).toBeUndefined();
	});

	it("should NOT block subagent for self-referential shazam prompts", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		const results = emit("tool_call", {
			type: "tool_call",
			toolName: "subagent",
			input: {
				prompt:
					"Review hooks/safety.ts for potential issues. Check if shazam_verify is called correctly and error handling is proper.",
			},
		} as unknown as ToolCallEvent);

		expect(results).toHaveLength(1);
		expect(results[0]).toBeUndefined();
	});

	it("should NOT block short prompts", () => {
		const { pi, emit } = createMockPi();
		registerAgentContextGuard(pi);

		const results = emit("tool_call", {
			type: "tool_call",
			toolName: "agent",
			input: { prompt: "Short query." },
		} as unknown as ToolCallEvent);

		expect(results).toHaveLength(1);
		expect(results[0]).toBeUndefined();
	});
});

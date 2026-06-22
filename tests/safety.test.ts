/**
 * Tests for hooks/safety — pre-commit gate.
 *
 * Verifies that when shazam_verify was NOT called recently, a `git commit`
 * tool_call is auto-blocked with a reason string (no interactive popup).
 * When verify WAS called, commit is allowed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerSafetyHooks } from "../hooks/safety.js";
import { markVerifyCalled, resetVerifyState } from "../hooks/verify-state.js";
import type { ExtensionAPI, ToolCallEvent, ExtensionContext } from "../types/pi-extension.js";

type Handler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>;

function buildFakePi(): { pi: ExtensionAPI; handler: { current: Handler | null } } {
	const handler: { current: Handler | null } = { current: null };
	const pi = {
		on: (event: string, h: Handler) => {
			if (event === "tool_call") handler.current = h;
		},
	} as unknown as ExtensionAPI;
	return { pi, handler };
}

function buildCtx(): ExtensionContext {
	return {
		ui: {
			confirm: vi.fn().mockResolvedValue(false),
			select: vi.fn().mockResolvedValue("Skip verification"),
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
		cwd: "/project",
	} as unknown as ExtensionContext;
}

function buildBashEvent(cmd: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		input: { command: cmd },
		toolCallId: "call_1",
	} as unknown as ToolCallEvent;
}

describe("hooks/safety pre-commit gate", () => {
	beforeEach(() => {
		resetVerifyState();
	});

	it("should auto-block git commit when no recent verify (no popup)", async () => {
		const { pi, handler } = buildFakePi();
		registerSafetyHooks(pi);
		expect(handler.current).toBeTruthy();

		const ctx = buildCtx();
		const result = (await handler.current!(buildBashEvent("git commit -m test"), ctx)) as
			| { block: boolean; reason?: string }
			| undefined;

		expect(result).toBeDefined();
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/shazam_verify/);
		// UI popup must NOT be called (the whole point of the fix)
		expect((ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
		expect((ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	it("should allow git commit when verify was called recently", async () => {
		const { pi, handler } = buildFakePi();
		registerSafetyHooks(pi);
		markVerifyCalled("[PASS] READY");

		const ctx = buildCtx();
		const result = await handler.current!(buildBashEvent("git commit -m test"), ctx);
		expect(result).toBeUndefined();
	});

	it("should allow git commit with --no-verify flag even without recent verify", async () => {
		const { pi, handler } = buildFakePi();
		registerSafetyHooks(pi);

		const ctx = buildCtx();
		const result = await handler.current!(buildBashEvent("git commit --no-verify -m skip"), ctx);
		expect(result).toBeUndefined();
	});

	it("should allow git commit with combined short flag -nq (fix #376 F2)", async () => {
		const { pi, handler } = buildFakePi();
		registerSafetyHooks(pi);

		const ctx = buildCtx();
		const result = await handler.current!(buildBashEvent("git commit -nq -m skip"), ctx);
		expect(result).toBeUndefined();
	});

	it("should allow git commit with combined short flag -qn (fix #376 F2)", async () => {
		const { pi, handler } = buildFakePi();
		registerSafetyHooks(pi);

		const ctx = buildCtx();
		const result = await handler.current!(buildBashEvent("git commit -qn -m skip"), ctx);
		expect(result).toBeUndefined();
	});

	it("should block git commit when combined flags don't contain 'n' (fix #376 F2)", async () => {
		const { pi, handler } = buildFakePi();
		registerSafetyHooks(pi);

		const ctx = buildCtx();
		// -qm does NOT contain 'n', so should be blocked
		const result = await handler.current!(buildBashEvent("git commit -qm 'msg'"), ctx);
		expect(result).toBeDefined();
		expect((result as any)?.block).toBe(true);
	});

	it("should ignore non-bash tool calls", async () => {
		const { pi, handler } = buildFakePi();
		registerSafetyHooks(pi);

		const ctx = buildCtx();
		const event = {
			type: "tool_call",
			toolName: "write",
			input: { path: "README.md", content: "x" },
			toolCallId: "call_2",
		} as unknown as ToolCallEvent;
		const result = await handler.current!(event, ctx);
		expect(result).toBeUndefined();
	});
});

/**
 * Tests for hooks/precommit-verify -- non-blocking pre-commit reminder.
 *
 * Verifies that on `git commit`, the hook does NOT block (returns undefined),
 * but instead sends a steer message. `git commit --no-verify` skips the reminder.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerPrecommitVerify } from "../hooks/precommit-verify.js";
import type { ExtensionAPI, ToolCallEvent, ExtensionContext } from "../types/pi-extension.js";

type Handler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>;

function buildFakePi(): { pi: ExtensionAPI; handler: { current: Handler | null } } {
	const handler: { current: Handler | null } = { current: null };
	const pi = {
		on: (event: string, h: Handler) => {
			if (event === "tool_call") handler.current = h;
		},
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	return { pi, handler };
}

function buildCtx(): ExtensionContext {
	return {
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

describe("hooks/precommit-verify", () => {
	it("should NOT block git commit (returns undefined)", async () => {
		const { pi, handler } = buildFakePi();
		registerPrecommitVerify(pi);
		expect(handler.current).toBeTruthy();

		const ctx = buildCtx();
		const result = await handler.current!(buildBashEvent("git commit -m test"), ctx);
		expect(result).toBeUndefined();
	});

	it("should NOT block git commit with --no-verify", async () => {
		const { pi, handler } = buildFakePi();
		registerPrecommitVerify(pi);

		const ctx = buildCtx();
		const result = await handler.current!(buildBashEvent("git commit --no-verify -m skip"), ctx);
		expect(result).toBeUndefined();
	});

	it("should NOT block git commit with combined -nq flag", async () => {
		const { pi, handler } = buildFakePi();
		registerPrecommitVerify(pi);

		const ctx = buildCtx();
		const result = await handler.current!(buildBashEvent("git commit -nq -m skip"), ctx);
		expect(result).toBeUndefined();
	});

	it("should NOT block any command (always returns undefined)", async () => {
		const { pi, handler } = buildFakePi();
		registerPrecommitVerify(pi);

		const ctx = buildCtx();

		const cases = [
			"rm -rf /tmp/data",
			"rm -r ./dist",
			"dd if=/dev/zero of=/dev/sda bs=1M",
			"mkfs.ext4 /dev/sdb1",
			"chmod 777 /",
			"iptables -F",
			"fdisk /dev/sda",
			"echo safe && git commit -m 'test'",
			"ls -la",
		];

		for (const cmd of cases) {
			const result = await handler.current!(buildBashEvent(cmd), ctx);
			expect(result).toBeUndefined();
		}
	});

	it("should ignore non-bash tool calls", async () => {
		const { pi, handler } = buildFakePi();
		registerPrecommitVerify(pi);

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

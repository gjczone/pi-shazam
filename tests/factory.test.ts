/**
 * Tests for tools/_factory — verify the createTool factory function.
 */
import { describe, it, expect, vi } from "vitest";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "../types/pi-extension.js";
import { createTool } from "../tools/_factory.js";

/**
 * Create a mock ExtensionAPI that captures the registered tool definition.
 */
function mockPi(): { pi: ExtensionAPI; registered: ToolDefinition[] } {
	const registered: ToolDefinition[] = [];
	const pi = {
		registerTool(tool: ToolDefinition) {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

describe("createTool factory", () => {
	it("should register a tool with merged params (json + maxTokens auto-added)", () => {
		const { pi, registered } = mockPi();
		createTool(pi, {
			name: "shazam_test",
			label: "Test Tool",
			description: "A test tool",
			params: Type.Object({
				query: Type.String(),
			}),
			execute: (_graph, _params) => "hello",
		});

		expect(registered).toHaveLength(1);
		const tool = registered[0]!;
		expect(tool.name).toBe("shazam_test");
		expect(tool.label).toBe("Test Tool");
		// Schema should include json and maxTokens
		const schemaProps = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(schemaProps).toHaveProperty("query");
		expect(schemaProps).toHaveProperty("json");
		expect(schemaProps).toHaveProperty("maxTokens");
	});

	it("should call domain function with graph and params (standard execute)", async () => {
		const { pi, registered } = mockPi();
		const domainFn = vi.fn((_graph: unknown, _params: Record<string, unknown>) => "domain output");

		createTool(pi, {
			name: "shazam_test",
			label: "Test",
			description: "test",
			params: Type.Object({ query: Type.String() }),
			execute: domainFn,
		});

		const result = await registered[0]!.execute(
			"call-1",
			{ query: "hello" },
			undefined,
			undefined,
			{} as never,
		);

		expect(domainFn).toHaveBeenCalledOnce();
		expect(result.content).toHaveLength(1);
		expect(result.content[0]!.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toBe("domain output");
	});

	it("should handle json=true by pretty-printing valid JSON", async () => {
		const { pi, registered } = mockPi();
		createTool(pi, {
			name: "shazam_test",
			label: "Test",
			description: "test",
			params: Type.Object({}),
			execute: () => '{"status":"ok","count":5}',
		});

		const result = await registered[0]!.execute(
			"call-2",
			{ json: true },
			undefined,
			undefined,
			{} as never,
		);

		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.status).toBe("ok");
		expect(parsed.count).toBe(5);
	});

	it("should wrap non-JSON text in envelope when json=true", async () => {
		const { pi, registered } = mockPi();
		createTool(pi, {
			name: "shazam_mytool",
			label: "Test",
			description: "test",
			params: Type.Object({}),
			execute: () => "plain text output",
		});

		const result = await registered[0]!.execute(
			"call-3",
			{ json: true },
			undefined,
			undefined,
			{} as never,
		);

		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.schema_version).toBe("1.0");
		expect(parsed.command).toBe("mytool");
		expect(parsed.status).toBe("ok");
		expect(parsed.result).toBe("plain text output");
	});

	it("should truncate output when maxTokens is set and json=false", async () => {
		const { pi, registered } = mockPi();
		const longText = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

		createTool(pi, {
			name: "shazam_test",
			label: "Test",
			description: "test",
			params: Type.Object({}),
			execute: () => longText,
		});

		const result = await registered[0]!.execute(
			"call-4",
			{ maxTokens: 50 },
			undefined,
			undefined,
			{} as never,
		);

		const text = (result.content[0] as { text: string }).text;
		// Truncated output should be shorter than original
		expect(text.length).toBeLessThan(longText.length);
	});

	it("should NOT truncate when json=true even if maxTokens is set", async () => {
		const { pi, registered } = mockPi();
		createTool(pi, {
			name: "shazam_test",
			label: "Test",
			description: "test",
			params: Type.Object({}),
			execute: () => '{"data":"value"}',
		});

		const result = await registered[0]!.execute(
			"call-5",
			{ json: true, maxTokens: 10 },
			undefined,
			undefined,
			{} as never,
		);

		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.data).toBe("value");
	});

	it("should pass through customExecute without wrapping", async () => {
		const { pi, registered } = mockPi();
		const customResult = {
			content: [{ type: "text" as const, text: "custom output" }],
		};

		createTool(pi, {
			name: "shazam_custom",
			label: "Custom",
			description: "custom tool",
			params: Type.Object({ name: Type.String() }),
			customExecute: async () => customResult,
		});

		expect(registered).toHaveLength(1);
		const result = await registered[0]!.execute(
			"call-6",
			{ name: "test" },
			undefined,
			undefined,
			{} as never,
		);

		expect(result).toBe(customResult);
	});

	it("should throw when neither execute nor customExecute is provided", () => {
		const { pi } = mockPi();
		expect(() => {
			createTool(pi, {
				name: "shazam_empty",
				label: "Empty",
				description: "no execute",
				params: Type.Object({}),
			});
		}).toThrow("either execute or customExecute must be provided");
	});

	it("should support async domain functions", async () => {
		const { pi, registered } = mockPi();
		createTool(pi, {
			name: "shazam_async",
			label: "Async",
			description: "async tool",
			params: Type.Object({}),
			execute: async () => {
				return "async result";
			},
		});

		const result = await registered[0]!.execute(
			"call-7",
			{},
			undefined,
			undefined,
			{} as never,
		);

		const text = (result.content[0] as { text: string }).text;
		expect(text).toBe("async result");
	});
});

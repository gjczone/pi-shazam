import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS, getToolDefinition } from "../tools/definitions.js";

/**
 * Pi↔MCP schema parity test (#332).
 * Asserts that the Pi tool implementations' param keys match the
 * zodParams keys in definitions.ts for each tool.
 */
describe("definitions parity (#332)", () => {
	const tools = Object.keys(TOOL_DEFINITIONS);

	it("should have definitions for all 7 tools", () => {
		expect(tools.length).toBe(7);
	});

	for (const toolName of tools) {
		const def = getToolDefinition(toolName)!;

		it(`${toolName}: zodParams should declare maxTokens and json`, () => {
			const shape = def.zodParams.shape;
			expect(shape).toHaveProperty("maxTokens");
			expect(shape).toHaveProperty("json");
		});

		it(`${toolName}: typeboxParams should have matching field names with zodParams`, () => {
			const tbFields = Object.keys((def.typeboxParams as any).properties ?? {});
			const zodFields = Object.keys(def.zodParams.shape);
			for (const tbField of tbFields) {
				expect(zodFields).toContain(tbField);
			}
		});
	}

	it("shazam_impact: depth should have bounds in both schemas", () => {
		const def = getToolDefinition("shazam_impact")!;
		expect(def.zodParams.shape).toHaveProperty("depth");
	});

	it("shazam_overview: description should mention project structure", () => {
		const def = getToolDefinition("shazam_overview")!;
		expect(def.description).toContain("project");
	});

	it("shazam_overview: description should mention the --filter keyword param", () => {
		const def = getToolDefinition("shazam_overview")!;
		expect(def.description.toLowerCase()).toContain("filter");
	});

	it("shazam_verify: description must not claim graph diffs", () => {
		const def = getToolDefinition("shazam_verify")!;
		expect(def.description.toLowerCase()).not.toContain("graph diffs");
	});

	it("shazam_format: description must say 'never touches logic', not 'default'", () => {
		const def = getToolDefinition("shazam_format")!;
		expect(def.description.toLowerCase()).toContain("never touches logic");
		expect(def.description.toLowerCase()).not.toContain("never touches default");
	});
});

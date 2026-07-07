/**
 * tests/github-action-yaml.test.ts
 *
 * Validates that `.github/actions/shazam-verify/action.yml` is well-formed:
 * - Has `name`, `description`, `inputs`, `runs` fields
 * - `runs.using` is `composite`
 * - Required inputs exist: `project-root`, `fail-on-verdict`, `max-files`
 * - Default values match the issue spec
 *
 * #638: GitHub Action wrapper for shazam_verify
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const actionPath = resolve(__dirname, "../.github/actions/shazam-verify/action.yml");

describe("action.yml validation", () => {
	const raw = readFileSync(actionPath, "utf-8");
	const action = YAML.parse(raw);

	it("has name and description", () => {
		expect(action.name).toBe("shazam-verify");
		expect(typeof action.description).toBe("string");
		expect(action.description.length).toBeGreaterThan(0);
	});

	it("uses composite action type", () => {
		expect(action.runs).toBeDefined();
		expect(action.runs.using).toBe("composite");
	});

	it("has required inputs with correct defaults", () => {
		expect(action.inputs).toBeDefined();

		// project-root
		expect(action.inputs["project-root"]).toBeDefined();
		expect(action.inputs["project-root"].default).toBe(".");
		expect(action.inputs["project-root"].required).toBe(false);

		// fail-on-verdict
		expect(action.inputs["fail-on-verdict"]).toBeDefined();
		expect(action.inputs["fail-on-verdict"].default).toBe("false");
		expect(action.inputs["fail-on-verdict"].required).toBe(false);

		// max-files
		expect(action.inputs["max-files"]).toBeDefined();
		expect(action.inputs["max-files"].default).toBe("100");
		expect(action.inputs["max-files"].required).toBe(false);
	});

	it("has at least 3 steps in the composite action", () => {
		expect(action.runs.steps).toBeDefined();
		expect(action.runs.steps.length).toBeGreaterThanOrEqual(3);
	});

	it("each step has a name and uses a shell or action", () => {
		for (const step of action.runs.steps) {
			expect(step.name).toBeDefined();
			expect(typeof step.name).toBe("string");
			// Each step must either use an action (uses) or a shell command (run + shell)
			const hasUses = typeof step.uses === "string";
			const hasRun = typeof step.run === "string" && typeof step.shell === "string";
			expect(hasUses || hasRun).toBe(true);
		}
	});

	it("first step sets up Node.js", () => {
		const firstStep = action.runs.steps[0];
		expect(firstStep.name).toMatch(/Node/i);
		expect(firstStep.uses).toMatch(/setup-node/);
	});

	it("env maps inputs correctly", () => {
		const verifyStep = action.runs.steps.find((s) => s.name && s.name.includes("Run shazam_verify"));
		expect(verifyStep).toBeDefined();
		expect(verifyStep!.env).toBeDefined();
		expect(verifyStep!.env["INPUT_PROJECT_ROOT"]).toContain("inputs.project-root");
		expect(verifyStep!.env["INPUT_FAIL_ON_VERDICT"]).toContain("inputs.fail-on-verdict");
		expect(verifyStep!.env["INPUT_MAX_FILES"]).toContain("inputs.max-files");
	});

	it("entrypoint.sh and post-comment.sh are referenced", () => {
		const stepRun = action.runs.steps.find((s) => s.run && s.run.includes("entrypoint.sh"));
		expect(stepRun).toBeDefined();

		const commentStep = action.runs.steps.find((s) => s.run && s.run.includes("post-comment.sh"));
		expect(commentStep).toBeDefined();
	});
});

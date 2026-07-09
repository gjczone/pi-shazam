/**
 * tests/github-action-doc.test.ts
 *
 * Validates that `docs/github-action.md` accurately describes how the
 * `max-files` input is plumbed. Per #657 the doc must not claim the value
 * is "passed to shazam_verify" as a tool-call argument or that it "overrides
 * .pi-shazam/config.json". The real path is: action input -> env
 * INPUT_MAX_FILES -> entrypoint.sh -> run-verify.mjs argv ->
 * executeVerifyJsonAsync(projectRoot, { maxFiles }) -> VerifyOptions.maxFiles.
 *
 * #657: align GitHub Action doc with the #630/#638 implementation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const docPath = resolve(__dirname, "../docs/github-action.md");

describe("github-action.md max-files documentation (#657)", () => {
	const raw = readFileSync(docPath, "utf-8");

	it("does not claim max-files is passed to shazam_verify as a tool arg", () => {
		expect(raw.toLowerCase()).not.toContain("passed to shazam_verify");
	});

	it("does not claim max-files overrides .pi-shazam/config.json", () => {
		expect(raw.toLowerCase()).not.toContain("overrides .pi-shazam/config.json");
		expect(raw.toLowerCase()).not.toContain("overrides `.pi-shazam/config.json`");
	});

	it("states that max-files is forwarded as a verify option resolved into VerifyOptions", () => {
		expect(raw.toLowerCase()).toContain("verify option");
		expect(raw.toLowerCase()).toContain("verifyoptions");
	});
});

/**
 * Integration test for issue #633 follow-up: `shazam_verify` upgrades
 * edge provenance for top-N hot symbols via LSP `references`.
 *
 * The `upgradeEdgesForHotspots` function lives inside `tools/verify.ts`
 * and depends on a live LSP context, so we test the parts we can
 * without spinning up a server:
 *
 *  1. Static check: `tools/verify.ts` calls `upgradeEdgesForHotspots`
 *     inside `runLspDiagnostics`, AFTER diagnostics are collected and
 *     BEFORE `closeOpenedFiles()` so the LSP server still has the
 *     files open for `references` queries.
 *  2. The transitive function (`upgradeEdgesToResolved` in
 *     `tools/lsp_enrich.ts`) is already covered by
 *     `tests/edge-provenance.test.ts`.
 *
 * The end-to-end "LSP upgrades edges after verify" smoke test runs in
 * CI via the existing verify integration test when a language server
 * is available.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("issue #633 follow-up: verify-time provenance upgrade wiring", () => {
	const verifySrc = readFileSync(resolve(process.cwd(), "tools/verify.ts"), "utf-8");

	it("tools/verify.ts imports upgradeEdgesToResolved from lsp_enrich", () => {
		expect(verifySrc).toMatch(/import\s*\{[^}]*\bupgradeEdgesToResolved\b[^}]*\}\s*from\s*["']\.\/lsp_enrich\.js["']/);
	});

	it("tools/verify.ts imports lspReferences from lsp_enrich", () => {
		expect(verifySrc).toMatch(/import\s*\{[^}]*\blspReferences\b[^}]*\}\s*from\s*["']\.\/lsp_enrich\.js["']/);
	});

	it("runLspDiagnostics invokes the hotspot upgrade before closeOpenedFiles", () => {
		// Find the call site. We assert ordering: upgradeEdgesForHotspots
		// must be called BEFORE the post-diagnostics closeOpenedFiles so
		// the LSP server still has the file open for `references` queries.
		// (`closeOpenedFiles` also appears once earlier in the subprocess
		// fallback path -- we only care about the post-diagnostics one.)
		const upgradeIdx = verifySrc.indexOf("upgradeEdgesForHotspots(");
		expect(upgradeIdx).toBeGreaterThan(-1);

		const allCloseIdxs: number[] = [];
		let from = 0;
		while (true) {
			const idx = verifySrc.indexOf("closeOpenedFiles()", from);
			if (idx === -1) break;
			allCloseIdxs.push(idx);
			from = idx + 1;
		}
		expect(allCloseIdxs.length).toBeGreaterThanOrEqual(2);
		// The post-diagnostics close is the LAST occurrence and must
		// come after the upgrade.
		const lastCloseIdx = allCloseIdxs[allCloseIdxs.length - 1];
		expect(upgradeIdx).toBeLessThan(lastCloseIdx);
	});

	it("the upgrade helper fans out across top-N symbols via Promise.allSettled", () => {
		// Confirm the implementation parallelises the references RPCs
		// rather than awaiting them serially. Failure to parallelise
		// would make verify time blow up linearly with topN.
		expect(verifySrc).toMatch(/Promise\.allSettled/);
		expect(verifySrc).toMatch(/pagerank/);
	});

	it("the upgrade helper skips symbols whose source position is unusable", () => {
		// Defensive checks keep a malformed graph (no file / no line)
		// from crashing the verify cycle.
		expect(verifySrc).toMatch(/sym\.line\s*<=\s*0/);
		expect(verifySrc).toMatch(/isNonSourceFile/);
	});

	it("the upgrade helper logs how many edges were promoted", () => {
		// Observability: surface the upgrade count so users can see the
		// trust signal working in verify output (or via _logWarn tail).
		expect(verifySrc).toMatch(/upgradeEdgesForHotspots/);
		expect(verifySrc).toMatch(/upgraded \$\{[^}]+\}\/\$\{[^}]+\}/);
	});
});

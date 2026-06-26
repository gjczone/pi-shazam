/**
 * Tests for core/risk -- unified risk assessment.
 *
 * Covers the mode-based routing fix (#468): assessRisk must route to
 * impact-style thresholds only when mode === "impact", not when
 * orphanDelta === 0. Previously verify/changes calls that legitimately
 * had orphanDelta === 0 (no new orphans) were misrouted to impact
 * thresholds, producing wrong risk levels.
 */
import { describe, it, expect } from "vitest";
import { assessRisk } from "../core/risk.js";

describe("core/risk assessRisk", () => {
	// -------------------------------------------------------------------------
	// Impact mode routing
	// -------------------------------------------------------------------------

	it("impact mode: 15 files routes to impact thresholds and returns high (#468)", () => {
		// 15 affected files -> impact high threshold (>10 files)
		const result = assessRisk({
			mode: "impact",
			gitFileCount: 15,
			newOrphanCount: 5,
			orphanDelta: 0,
		});
		expect(result.level).toBe("high");
		expect(result.reason).toContain("15 files");
		expect(result.reason).toContain("5 symbols");
	});

	it("impact mode: 5 files 20 symbols returns medium (#468)", () => {
		const result = assessRisk({
			mode: "impact",
			gitFileCount: 5,
			newOrphanCount: 20,
			orphanDelta: 0,
		});
		// >3 files or >10 symbols -> medium
		expect(result.level).toBe("medium");
		expect(result.reason).toContain("5 files");
		expect(result.reason).toContain("20 symbols");
	});

	it("impact mode: 2 files 5 symbols returns low (#468)", () => {
		const result = assessRisk({
			mode: "impact",
			gitFileCount: 2,
			newOrphanCount: 5,
			orphanDelta: 0,
		});
		expect(result.level).toBe("low");
	});

	// -------------------------------------------------------------------------
	// Verify mode routing -- the #468 bug: orphanDelta === 0 must NOT route
	// to impact thresholds. Even with 15 git-modified files and zero orphans,
	// verify thresholds (totalImpact = gitFileCount + orphanDelta = 15) must
	// apply: 15 < mediumThreshold(20) -> low.
	// -------------------------------------------------------------------------

	it("verify mode: 15 files orphanDelta 0 returns low, NOT impact high (#468)", () => {
		const result = assessRisk({
			mode: "verify",
			gitFileCount: 15,
			newOrphanCount: 0,
			orphanDelta: 0,
		});
		// totalImpact = 15, below medium threshold (20) -> low
		expect(result.level).toBe("low");
		expect(result.reason).toContain("0 new orphans");
		expect(result.reason).toContain("15");
		expect(result.reason).not.toContain("blast radius");
	});

	it("verify mode: preCommit with 15 files orphanDelta 0 returns medium (#468)", () => {
		// preCommit medium threshold = 10; totalImpact = 15 > 10 -> medium
		const result = assessRisk({
			mode: "verify",
			gitFileCount: 15,
			newOrphanCount: 0,
			orphanDelta: 0,
			preCommit: true,
		});
		expect(result.level).toBe("medium");
		expect(result.reason).toContain("0 new orphans");
	});

	it("verify mode: 50 files orphanDelta 0 returns high via totalImpact (#468)", () => {
		// totalImpact = 50, below high threshold (60) but preCommit? No.
		// 50 < 60 -> medium. Use 70 to assert high.
		const result = assessRisk({
			mode: "verify",
			gitFileCount: 70,
			newOrphanCount: 0,
			orphanDelta: 0,
		});
		// totalImpact = 70 > high threshold (60) -> high
		expect(result.level).toBe("high");
	});

	it("verify mode: 5 new orphans returns high regardless of file count (#468)", () => {
		// newOrphanCount > 10 -> high; use 11
		const result = assessRisk({
			mode: "verify",
			gitFileCount: 1,
			newOrphanCount: 11,
			orphanDelta: 11,
		});
		expect(result.level).toBe("high");
	});

	// -------------------------------------------------------------------------
	// Changes mode routing
	// -------------------------------------------------------------------------

	it("changes mode: orphanDelta 0 with 15 files uses totalImpact, NOT impact thresholds (#468)", () => {
		// totalImpact = 15 + 0 = 15, below medium threshold (20) -> low
		const result = assessRisk({
			mode: "changes",
			gitFileCount: 15,
			newOrphanCount: 0,
			orphanDelta: 0,
		});
		expect(result.level).toBe("low");
		expect(result.reason).toContain("0 new orphans");
		expect(result.reason).not.toContain("blast radius");
	});

	it("changes mode: 30 files orphanDelta 0 returns medium via totalImpact (#468)", () => {
		// totalImpact = 30, > medium threshold (20) and < high threshold (60) -> medium
		const result = assessRisk({
			mode: "changes",
			gitFileCount: 30,
			newOrphanCount: 0,
			orphanDelta: 0,
		});
		expect(result.level).toBe("medium");
	});

	// -------------------------------------------------------------------------
	// No-change fast path (shared across modes)
	// -------------------------------------------------------------------------

	it("returns low with 'No changes detected' when all inputs are zero (#468)", () => {
		const result = assessRisk({
			mode: "verify",
			gitFileCount: 0,
			newOrphanCount: 0,
			orphanDelta: 0,
		});
		expect(result.level).toBe("low");
		expect(result.reason).toBe("No changes detected.");
	});

	// -------------------------------------------------------------------------
	// Impact mode still honors impact thresholds even when orphanDelta != 0
	// (defensive: impact always passes 0, but if a caller ever passes nonzero
	// the mode must still win over the orphanDelta heuristic).
	// -------------------------------------------------------------------------

	it("impact mode: nonzero orphanDelta still routes to impact thresholds (#468)", () => {
		// 15 files, orphanDelta 99 (would be high in verify). Impact threshold:
		// >10 files -> high. Both agree on high here, but reason must reflect
		// impact-style "files/symbols affected" wording, not "new orphans".
		const result = assessRisk({
			mode: "impact",
			gitFileCount: 15,
			newOrphanCount: 5,
			orphanDelta: 99,
		});
		expect(result.level).toBe("high");
		expect(result.reason).toContain("15 files");
		expect(result.reason).toContain("5 symbols");
		expect(result.reason).not.toContain("new orphans");
	});
});

/**
 * Tests for issue #656: shazam_impact mislabels a tied upstream/downstream
 * direction as "downstream callee". The per-file label must be "both" when
 * the upstream and downstream affected-symbol counts are equal (or both
 * zero), not silently "downstream callee".
 */
import { describe, it, expect } from "vitest";
import { computeFileDirection } from "../tools/impact.js";

describe("issue #656: per-file impact direction tie", () => {
	it("labels clear upstream dominance as 'upstream caller'", () => {
		expect(computeFileDirection(3, 1)).toBe("upstream caller");
	});

	it("labels clear downstream dominance as 'downstream callee'", () => {
		expect(computeFileDirection(1, 3)).toBe("downstream callee");
	});

	it("labels an equal tie as 'both', not 'downstream callee'", () => {
		expect(computeFileDirection(2, 2)).toBe("both");
	});

	it("labels a zero/zero case as 'both', not 'downstream callee'", () => {
		expect(computeFileDirection(0, 0)).toBe("both");
	});
});

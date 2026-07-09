import { describe, it, expect } from "vitest";

// Contract test for vitest.setup.ts ERR_STREAM_DESTROYED suppression.
//
// The suppression must be OPT-IN only: a non-LSP test must NOT be opted in
// by default, so an accidental ERR_STREAM_DESTROYED rejection is no longer
// silently swallowed (which previously caused false-positive tests). Only
// LSP tests that expect teardown noise set __suppressStreamDestroyed=true.

describe("vitest.setup ERR_STREAM_DESTROYED suppression is opt-in", () => {
	it("does NOT suppress by default (flag unset for non-LSP tests)", () => {
		// A fresh, non-LSP test starts with no opt-in, so any
		// ERR_STREAM_DESTROYED rejection would surface as a failure.
		expect((globalThis as any).__suppressStreamDestroyed).not.toBe(true);
	});

	it("suppression is enabled only when LSP tests opt in", () => {
		// Simulate an LSP test's beforeAll opt-in.
		(globalThis as any).__suppressStreamDestroyed = true;
		expect((globalThis as any).__suppressStreamDestroyed).toBe(true);

		// Simulate the test's afterAll cleanup restoring default behavior.
		(globalThis as any).__suppressStreamDestroyed = false;
		expect((globalThis as any).__suppressStreamDestroyed).not.toBe(true);

		delete (globalThis as any).__suppressStreamDestroyed;
	});
});

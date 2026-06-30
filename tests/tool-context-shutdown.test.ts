/**
 * Regression tests for issue #546:
 * `_shutdownPromise` declared but never assigned in `tools/_context.ts` —
 * `awaitPreviousShutdown()` reads a permanently-null variable, so concurrent
 * `setLspManager` callers and `before_agent_start` can race against an
 * in-flight previous-manager shutdown.
 *
 * Contract verified:
 *   1. `awaitPreviousShutdown()` must wait for an in-flight previous-manager
 *      shutdown that was kicked off by a concurrent `setLspManager` call.
 *   2. After `awaitPreviousShutdown()` returns, `_manager` reflects the new
 *      manager (the swap has completed).
 *   3. `_shutdownPromise` is assigned at least once in the source (grep gate).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LspManager } from "../lsp/manager.js";
import { setLspManager, getLspManager, awaitPreviousShutdown } from "../tools/_context.js";

function makeMockManager(shutdownImpl: () => Promise<void>): LspManager {
	return {
		shutdown: vi.fn(shutdownImpl),
	} as unknown as LspManager;
}

describe("issue #546: setLspManager serializes via _shutdownPromise", () => {
	// Use a sentinel manager as the "clean" state between tests. We cannot
	// reset `_manager` to null from outside the module, so we install a known
	// no-op manager instead.
	const sentinelManager = makeMockManager(async () => {});

	afterEach(async () => {
		// Restore to a known no-op manager so tests do not leak state across
		// describe blocks. The sentinel's shutdown is a no-op, so installing
		// it never blocks.
		await setLspManager(sentinelManager);
	});

	it("awaitPreviousShutdown waits for an in-flight previous-manager shutdown", async () => {
		let resolveAShutdown: () => void = () => {};
		const managerA = makeMockManager(
			() =>
				new Promise<void>((resolve) => {
					resolveAShutdown = resolve;
				}),
		);
		const managerB = makeMockManager(async () => {});

		// Step 1: install A synchronously (no previous manager).
		await setLspManager(managerA);
		expect(getLspManager()).toBe(managerA);

		// Step 2: kick off setLspManager(B) WITHOUT awaiting. With the bug
		// (no _shutdownPromise assignment), the inner `await prev.shutdown()`
		// still blocks setLspManager from returning, but nothing else can
		// observe the in-flight shutdown. With the fix, _shutdownPromise is
		// assigned so awaitPreviousShutdown can wait on it.
		const setBPromise = setLspManager(managerB);

		try {
			// Flush microtasks so setLspManager(B) has entered its body and
			// reached the prev.shutdown() await.
			await Promise.resolve();
			await Promise.resolve();

			// A.shutdown has been called but not yet resolved.
			expect(managerA.shutdown).toHaveBeenCalledTimes(1);
			// _manager is still A — the swap has not happened.
			expect(getLspManager()).toBe(managerA);

			// Step 3: awaitPreviousShutdown must NOT return until A.shutdown
			// resolves. With the bug, this returns immediately.
			let awaitPreviousDone = false;
			const awaitPreviousPromise = awaitPreviousShutdown().then(() => {
				awaitPreviousDone = true;
			});

			// Yield once — with the bug, awaitPreviousDone would be true now.
			await Promise.resolve();
			expect(awaitPreviousDone).toBe(false);

			// Resolve A.shutdown — both setLspManager(B) and awaitPreviousShutdown
			// should now be unblocked.
			resolveAShutdown();

			await awaitPreviousPromise;

			expect(awaitPreviousDone).toBe(true);
			expect(getLspManager()).toBe(managerB);
		} finally {
			// Always unblock A.shutdown so setLspManager(B) can complete,
			// even if an assertion above failed and left setBPromise pending.
			resolveAShutdown();
			await setBPromise.catch(() => {});
		}
	});

	it("setLspManager with no previous manager does not hang on awaitPreviousShutdown", async () => {
		// Ensure _shutdownPromise is null when no prior shutdown is in-flight.
		// This guards against a regression where _shutdownPromise gets stuck
		// non-null after a prior test.
		await setLspManager(null as unknown as LspManager);

		const manager = makeMockManager(async () => {});

		// Should resolve immediately (no previous shutdown to wait for).
		await expect(setLspManager(manager)).resolves.toBeUndefined();
		expect(getLspManager()).toBe(manager);

		// awaitPreviousShutdown should also be a no-op.
		await expect(awaitPreviousShutdown()).resolves.toBeUndefined();
	});

	it("source assigns _shutdownPromise at least once (grep gate)", () => {
		// Static check: the variable must be assigned somewhere, not just
		// declared and read. This is the most direct regression gate for the
		// issue — the bug was "declared and read but never assigned."
		const src = readFileSync(join(import.meta.dirname, "..", "tools", "_context.ts"), "utf-8");
		// Match `_shutdownPromise =` (assignment), excluding `==` comparisons.
		const assignmentMatches = src.match(/_shutdownPromise\s*=[^=]/g) ?? [];
		expect(assignmentMatches.length).toBeGreaterThanOrEqual(1);
	});
});

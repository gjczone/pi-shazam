/**
 * Tests for hooks/verify-state — shared verify tracking.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
	markVerifyCalled,
	hasRecentVerify,
	resetVerifyState,
	onNewEdit,
	markReminderSent,
	wasReminderSent,
} from "../hooks/verify-state.js";

describe("hooks/verify-state", () => {
	beforeEach(() => {
		resetVerifyState();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("should return false initially (no verify called)", () => {
		expect(hasRecentVerify()).toBe(false);
	});

	it("should return true after markVerifyCalled", () => {
		markVerifyCalled();
		expect(hasRecentVerify()).toBe(true);
	});

	it("should return false after verify state is reset", () => {
		markVerifyCalled();
		expect(hasRecentVerify()).toBe(true);
		resetVerifyState();
		expect(hasRecentVerify()).toBe(false);
	});

	it("should return false when verify was called more than 5 minutes ago", () => {
		markVerifyCalled();
		expect(hasRecentVerify()).toBe(true);

		// Advance 6 minutes
		vi.advanceTimersByTime(6 * 60 * 1000);
		expect(hasRecentVerify()).toBe(false);
	});

	it("should return true when verify was called within 5 minutes", () => {
		markVerifyCalled();
		vi.advanceTimersByTime(4 * 60 * 1000);
		expect(hasRecentVerify()).toBe(true);
	});

	it("should reset verify flag on onNewEdit (post-verify edit detection)", () => {
		markVerifyCalled();
		expect(hasRecentVerify()).toBe(true);

		// Simulate a new edit after verify
		onNewEdit();
		expect(hasRecentVerify()).toBe(false);
	});

	it("should re-enable verify detection after onNewEdit + markVerifyCalled", () => {
		markVerifyCalled();
		onNewEdit();
		expect(hasRecentVerify()).toBe(false);

		// Verify again
		markVerifyCalled();
		expect(hasRecentVerify()).toBe(true);
	});

	describe("reminder deduplication", () => {
		it("should return false initially (no reminder sent)", () => {
			expect(wasReminderSent()).toBe(false);
		});

		it("should return true after markReminderSent", () => {
			markReminderSent();
			expect(wasReminderSent()).toBe(true);
		});

		it("should reset reminder flag on onNewEdit", () => {
			markReminderSent();
			expect(wasReminderSent()).toBe(true);
			onNewEdit();
			expect(wasReminderSent()).toBe(false);
		});

		it("should reset reminder flag on markVerifyCalled", () => {
			markReminderSent();
			expect(wasReminderSent()).toBe(true);
			markVerifyCalled();
			expect(wasReminderSent()).toBe(false);
		});

		it("should reset reminder flag on resetVerifyState", () => {
			markReminderSent();
			expect(wasReminderSent()).toBe(true);
			resetVerifyState();
			expect(wasReminderSent()).toBe(false);
		});

		it("should prevent repeated reminders: only one per batch of unverified edits", () => {
			// First reminder is allowed
			expect(wasReminderSent()).toBe(false);
			markReminderSent();
			expect(wasReminderSent()).toBe(true);

			// Second reminder is blocked (flag already set)
			// Simulate turn_end checking wasReminderSent() before sending
			expect(wasReminderSent()).toBe(true);

			// New edit resets the flag, allowing a fresh reminder
			onNewEdit();
			expect(wasReminderSent()).toBe(false);
			markReminderSent();
			expect(wasReminderSent()).toBe(true);
		});

		it("should allow reminder after verify + new edit cycle", () => {
			// Send reminder, then verify
			markReminderSent();
			markVerifyCalled();
			expect(wasReminderSent()).toBe(false);

			// New edit after verify: reminder should be allowed again
			onNewEdit();
			expect(wasReminderSent()).toBe(false);
			markReminderSent();
			expect(wasReminderSent()).toBe(true);
		});
	});
});

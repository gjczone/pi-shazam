/**
 * Tests for hooks/verify-state — shared verify tracking.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { markVerifyCalled, hasRecentVerify, resetVerifyState, onNewEdit } from "../hooks/verify-state.js";

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
});

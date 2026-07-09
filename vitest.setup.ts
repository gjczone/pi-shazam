// Suppress ERR_STREAM_DESTROYED ONLY when LSP teardown noise is expected.
// Tests that legitimately produce this during cleanup opt in via
// (globalThis as any).__suppressStreamDestroyed = true in beforeAll.
// Non-LSP tests that accidentally throw ERR_STREAM_DESTROYED will now
// correctly fail instead of being silently swallowed (false positives).
process.on("unhandledRejection", (reason: unknown) => {
	if (
		(globalThis as any).__suppressStreamDestroyed === true &&
		reason instanceof Error &&
		(reason as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED"
	) {
		return;
	}
	throw reason;
});

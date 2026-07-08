import { defineConfig } from "vitest/config";

// Windows + MSYS2 has slower process spawn, file I/O, and tree-sitter parse.
// Use a longer test timeout on win32 to avoid spurious failures on local dev.
// CI windows-latest runners are faster and still pass with 30s, but local
// Git Bash + MSYS2 needs more headroom (issue #676).
const testTimeout = process.platform === "win32" ? 60_000 : 30_000;

export default defineConfig({
	test: {
		setupFiles: ["./vitest.setup.ts"],
		testTimeout,
	},
});

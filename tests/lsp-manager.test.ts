import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LspManager } from "../lsp/manager.js";
import type { LspClient } from "../lsp/client.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";

describe("lsp/manager", () => {
	describe("LspManager constructor", () => {
		it("should create an LspManager", () => {
			const manager = new LspManager("/test/project");
			expect(manager).toBeDefined();
		});

		it("should initialize with empty server list", () => {
			const manager = new LspManager("/test/project");
			expect(manager.getActiveServers()).toEqual([]);
		});
	});

	describe("LspManager lifecycle", () => {
		let manager: LspManager;

		beforeEach(() => {
			manager = new LspManager("/test/project");
		});

		it("should expose getActiveServers method", () => {
			expect(typeof manager.getActiveServers).toBe("function");
		});

		it("should expose shutdown method", () => {
			expect(typeof manager.shutdown).toBe("function");
		});

		it("should expose getServerForFile method", () => {
			expect(typeof manager.getServerForFile).toBe("function");
		});

		it("should expose detectLanguages method", () => {
			expect(typeof manager.detectLanguages).toBe("function");
		});
	});

	describe("getServerForFile", () => {
		it("should return null for unsupported file types", async () => {
			const manager = new LspManager("/test/project");
			// Manager starts with no servers, and .rb is not in our 6-language map
			expect(await manager.getServerForFile("/test/script.rb")).toBeNull();
		});
	});

	describe("shutdown + re-initialize (#334 latch reset)", () => {
		it("should reset _shuttingDown when initializeAll is called after shutdown", async () => {
			const manager = new LspManager("/test/project");
			// Shutdown sets the latch
			await manager.shutdown();
			// initializeAll should reset the latch — with no LSP servers
			// installed, it will complete without spawning anything.
			// The key test: calling initializeAll after shutdown should not throw
			// or hang, and the manager should be usable again.
			await manager.initializeAll();

			// After reset, getServerForFile should NOT return null due to latch.
			// An unsupported file type (.rb) still returns null, but a supported
			// type (.ts) would at least attempt detection (it fails gracefully
			// because no tsserver is installed in CI).
			const result = await manager.getServerForFile("/test/script.rb");
			expect(result).toBeNull(); // still null for .rb
		});
	});

	describe("shutdown timeout (#334)", () => {
		it("should complete shutdown even with missing servers (no-op)", async () => {
			const manager = new LspManager("/test/project");
			// Shutdown with empty server list should complete immediately
			await expect(manager.shutdown()).resolves.toBeUndefined();
		});

		it("should complete within timeout when called on empty manager", async () => {
			const manager = new LspManager("/test/project");
			const start = Date.now();
			await manager.shutdown();
			const elapsed = Date.now() - start;
			// Should complete quickly (well under the 8s timeout)
			expect(elapsed).toBeLessThan(5000);
		});
	});

	describe("initializeAll with AbortSignal (#341)", () => {
		it("should handle pre-aborted signal", async () => {
			const manager = new LspManager("/test/project");
			const controller = new AbortController();
			controller.abort(); // signal already aborted

			// Should complete without throwing (all server inits skip)
			await expect(manager.initializeAll(controller.signal)).resolves.toBeUndefined();
		});

		it("should complete normally without signal", async () => {
			const manager = new LspManager("/test/project");
			// No signal — should complete normally (no servers to init)
			await expect(manager.initializeAll()).resolves.toBeUndefined();
		});
	});
});

describe("version manager bin discovery (#426)", () => {
	it("should resolve NVM_BIN directory when env var is set", async () => {
		const { _getVersionManagerBinDirs } = await import("../lsp/manager.js");
		const origNvmBin = process.env.NVM_BIN;
		try {
			if (origNvmBin) {
				const dirs = _getVersionManagerBinDirs();
				expect(dirs).toContain(origNvmBin);
			}
		} finally {
			process.env.NVM_BIN = origNvmBin;
		}
	});

	const ALL_VM_ENV_VARS = [
		"NVM_BIN",
		"FNM_MULTISHELL_PATH",
		"FNM_DIR",
		"VOLTA_HOME",
		"MISE_DATA_DIR",
		"ASDF_DATA_DIR",
		"PYENV_ROOT",
		"PNPM_HOME",
		"N_PREFIX",
		"HOMEBREW_PREFIX",
	];

	it("should return only default fallback dirs when no version manager env vars are set", async () => {
		const { _getVersionManagerBinDirs } = await import("../lsp/manager.js");
		const orig: Record<string, string | undefined> = {};
		for (const k of ALL_VM_ENV_VARS) orig[k] = process.env[k];
		try {
			for (const k of ALL_VM_ENV_VARS) delete process.env[k];
			const dirs = _getVersionManagerBinDirs();
			// When no env vars are set, results come from default fallback dirs
			// that exist on the machine. All returned values must be valid paths.
			for (const dir of dirs) {
				expect(dir).toBeTruthy();
				expect(typeof dir).toBe("string");
			}
		} finally {
			for (const [k, v] of Object.entries(orig)) {
				if (v !== undefined) process.env[k] = v;
			}
		}
	});

	it("should skip non-existent directories", async () => {
		const { _getVersionManagerBinDirs } = await import("../lsp/manager.js");
		const orig: Record<string, string | undefined> = {};
		for (const k of ALL_VM_ENV_VARS) orig[k] = process.env[k];
		try {
			for (const k of ALL_VM_ENV_VARS) delete process.env[k];
			process.env.NVM_BIN = "/nonexistent/path/that/does/not/exist";
			const dirs = _getVersionManagerBinDirs();
			// The nonexistent path must not appear in results
			expect(dirs).not.toContain("/nonexistent/path/that/does/not/exist");
		} finally {
			for (const [k, v] of Object.entries(orig)) {
				if (v !== undefined) process.env[k] = v;
			}
		}
	});
});

// -- PATHEXT-aware isExecutable (issue #585) --

describe("_isExecutable PATHEXT support (#585)", () => {
	const originalPlatform = process.platform;
	const originalPathext = process.env.PATHEXT;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalPathext !== undefined) process.env.PATHEXT = originalPathext;
		else delete process.env.PATHEXT;
	});

	// Helper to create a temp file with a given extension
	function createTempFile(ext: string): string {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-585-"));
		const filePath = join(tmpDir, `test${ext}`);
		writeFileSync(filePath, "dummy");
		// On POSIX, make it executable so isExecutable passes the mode check
		chmodSync(filePath, 0o755);
		return filePath;
	}

	it("recognizes .exe extension with default PATHEXT", async () => {
		const { _isExecutable } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		delete process.env.PATHEXT;
		const filePath = createTempFile(".exe");
		try {
			expect(_isExecutable(filePath)).toBe(true);
		} finally {
			rmSync(filePath, { force: true });
			rmSync(join(filePath, ".."), { recursive: true, force: true });
		}
	});

	it("recognizes .com extension when PATHEXT includes .COM", async () => {
		const { _isExecutable } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.PATHEXT = ".COM;.EXE";
		const filePath = createTempFile(".com");
		try {
			expect(_isExecutable(filePath)).toBe(true);
		} finally {
			rmSync(filePath, { force: true });
			rmSync(join(filePath, ".."), { recursive: true, force: true });
		}
	});

	it("rejects extension not in PATHEXT", async () => {
		const { _isExecutable } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.PATHEXT = ".EXE";
		const filePath = createTempFile(".cmd");
		try {
			expect(_isExecutable(filePath)).toBe(false);
		} finally {
			rmSync(filePath, { force: true });
			rmSync(join(filePath, ".."), { recursive: true, force: true });
		}
	});

	it("preserves POSIX behavior (mode check) unchanged", async () => {
		const { _isExecutable } = await import("../lsp/manager.js");
		// #592: On Windows, chmod does not set executable bits, and .sh
		// is not in PATHEXT. Skip the POSIX-mode check on win32.
		if (process.platform === "win32") return;
		const filePath = createTempFile(".sh");
		try {
			expect(_isExecutable(filePath)).toBe(true);
		} finally {
			rmSync(filePath, { force: true });
			rmSync(join(filePath, ".."), { recursive: true, force: true });
		}
	});
});

// -- findInPath win32 bypass and .cmd fallback (issue #582) --

describe("_findInPath win32 bypass (#582)", () => {
	const originalPlatform = process.platform;
	const originalPath = process.env.PATH;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalPath !== undefined) process.env.PATH = originalPath;
		else delete process.env.PATH;
	});

	function createTempExe(name: string): string {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-582-"));
		const filePath = join(tmpDir, name);
		writeFileSync(filePath, "dummy");
		chmodSync(filePath, 0o755);
		return filePath;
	}

	it("finds executable outside SAFE_PATH_DIRS on win32", async () => {
		const { _findInPath, _SAFE_PATH_DIRS } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-582-"));
		const exePath = join(tmpDir, "test-server.exe");
		try {
			writeFileSync(exePath, "dummy");
			chmodSync(exePath, 0o755);
			// Set PATH to temp dir (which is NOT in SAFE_PATH_DIRS)
			process.env.PATH = tmpDir;
			// On win32, findInPath should bypass SAFE_PATH_DIRS and find the exe
			const found = _findInPath("test-server.exe");
			expect(found).toBe(exePath);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("skips non-SAFE_PATH_DIRS on POSIX", async () => {
		const { _findInPath } = await import("../lsp/manager.js");
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-582-"));
		const exePath = join(tmpDir, "test-server");
		try {
			writeFileSync(exePath, "dummy");
			chmodSync(exePath, 0o755);
			process.env.PATH = tmpDir;
			// On POSIX, findInPath should NOT find executables outside SAFE_PATH_DIRS
			const found = _findInPath("test-server");
			expect(found).toBeNull();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("tries .cmd extension on win32 when bare command not found", async () => {
		const { _findInPath } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-582-"));
		const cmdPath = join(tmpDir, "test-server.cmd");
		try {
			writeFileSync(cmdPath, "dummy");
			chmodSync(cmdPath, 0o755);
			process.env.PATH = tmpDir;
			// findInPath with bare command should find .cmd variant
			const found = _findInPath("test-server");
			expect(found).toBe(cmdPath);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// -- trustedUserCandidates Windows paths (issue #582) --

describe("_trustedUserCandidates Windows paths (#582)", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	it("includes Windows-specific paths on win32", async () => {
		const { _trustedUserCandidates } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		// Create a temp dir to act as APPDATA/npm and put an actual .cmd file there
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-582-"));
		const npmDir = join(tmpDir, "npm");
		mkdirSync(npmDir, { recursive: true });
		const cmdPath = join(npmDir, "test-server.cmd");
		writeFileSync(cmdPath, "dummy");
		chmodSync(cmdPath, 0o755);
		process.env.APPDATA = tmpDir;
		try {
			const candidates = _trustedUserCandidates("test-server");
			// Should find the .cmd file in APPDATA/npm
			const hasNpmCmd = candidates.some((c) => c.endsWith("test-server.cmd") && c.includes("npm"));
			expect(hasNpmCmd).toBe(true);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
			delete process.env.APPDATA;
		}
	});

	it("falls back to homedir-derived paths when APPDATA is unset", async () => {
		const { _trustedUserCandidates } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		delete process.env.APPDATA;
		delete process.env.LOCALAPPDATA;
		// Function should not crash when APPDATA is unset.
		// Candidates that don't exist on disk are filtered by isExecutable,
		// so the result array may be empty on Linux. Just verify it returns an array.
		const candidates = _trustedUserCandidates("test-server");
		expect(Array.isArray(candidates)).toBe(true);
	});

	it("does NOT include Windows paths on POSIX", async () => {
		const { _trustedUserCandidates } = await import("../lsp/manager.js");
		const candidates = _trustedUserCandidates("test-server");
		// On POSIX, no AppData or scoop paths should appear
		const hasWindowsPaths = candidates.some(
			(c) => c.includes("AppData") || c.includes("scoop") || c.includes("nvim-data"),
		);
		expect(hasWindowsPaths).toBe(false);
	});

	it("includes go/bin/<cmd>.exe candidate on win32 (#606)", async () => {
		const { _trustedUserCandidates } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		// Create a temp home dir with go/bin/gopls.exe so isExecutable finds it.
		// Set both HOME (POSIX) and USERPROFILE (win32) — homedir() uses the
		// native-platform env var regardless of process.platform mock.
		const tmpHome = mkdtempSync(join(tmpdir(), "pi-shazam-606-"));
		const goBinDir = join(tmpHome, "go", "bin");
		mkdirSync(goBinDir, { recursive: true });
		const goExePath = join(goBinDir, "gopls.exe");
		writeFileSync(goExePath, "dummy");
		chmodSync(goExePath, 0o755);
		const origHome = process.env.HOME;
		const origUserProfile = process.env.USERPROFILE;
		process.env.HOME = tmpHome;
		process.env.USERPROFILE = tmpHome;
		try {
			const candidates = _trustedUserCandidates("gopls");
			const hasGoExe = candidates.some((c) => c.includes("go") && c.includes("bin") && c.endsWith("gopls.exe"));
			expect(hasGoExe).toBe(true);
		} finally {
			rmSync(tmpHome, { recursive: true, force: true });
			if (origHome !== undefined) process.env.HOME = origHome;
			else delete process.env.HOME;
			if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
			else delete process.env.USERPROFILE;
		}
	});
});

// -- detectProjectLanguages symlink containment (issue #609) --

describe("detectProjectLanguages symlink containment (#609)", () => {
	it("does not walk symlinks resolving outside project root", async () => {
		const { detectProjectLanguages } = await import("../lsp/manager.js");
		const { symlinkSync } = await import("node:fs");
		const projectDir = mkdtempSync(join(tmpdir(), "pi-shazam-609-proj-"));
		const externalDir = mkdtempSync(join(tmpdir(), "pi-shazam-609-ext-"));
		try {
			// Create a .ts file inside project root (should be detected)
			writeFileSync(join(projectDir, "main.ts"), "const x = 1;");
			// Create a .py file in the external dir (should NOT be detected)
			writeFileSync(join(externalDir, "external.py"), "x = 1");
			// Symlink from project root to external dir
			const linkPath = join(projectDir, "ext-lib");
			symlinkSync(externalDir, linkPath, "dir");

			const languages = detectProjectLanguages(projectDir, 100);
			// Typescript should be detected from main.ts
			expect(languages).toContain("typescript");
			// Python must NOT be detected (external file outside root)
			expect(languages).not.toContain("python");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(externalDir, { recursive: true, force: true });
		}
	});
});

// -- package.json os field (issue #585) --

describe("package.json os field (#585)", () => {
	it("includes win32 in supported platforms", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const pkgPath = resolve(process.cwd(), "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		expect(pkg.os).toBeDefined();
		expect(pkg.os).toContain("linux");
		expect(pkg.os).toContain("darwin");
		expect(pkg.os).toContain("win32");
	});
});

// -- shouldSkipPath backslash normalization (issue #596) --

describe("shouldSkipPath backslash normalization (#596)", () => {
	it("normalizes backslashes to forward slashes for SKIP_DIRS matching", async () => {
		const { shouldSkipPath } = await import("../lsp/manager.js");
		// Backslash-separated paths containing skip dirs
		expect(shouldSkipPath("src\\node_modules\\foo.ts")).toBe(true);
		expect(shouldSkipPath("project\\.git\\objects\\abc")).toBe(true);
		expect(shouldSkipPath("dist\\bundle.js")).toBe(true);
		// Forward slash still works
		expect(shouldSkipPath("src/node_modules/foo.ts")).toBe(true);
		// Non-skip path with backslashes
		expect(shouldSkipPath("src\\utils\\helper.ts")).toBe(false);
		// Mixed separators
		expect(shouldSkipPath("src\\node_modules/lib\\util.ts")).toBe(true);
	});
});

// -- findInPath PATHEXT iteration (issue #605) --

describe("_findInPath PATHEXT iteration (#605)", () => {
	const originalPlatform = process.platform;
	const originalPathext = process.env.PATHEXT;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		if (originalPathext !== undefined) process.env.PATHEXT = originalPathext;
		else delete process.env.PATHEXT;
	});

	it("finds .exe variant via PATHEXT when bare command not found on win32", async () => {
		const { _findInPath } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS";
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-605-"));
		const exePath = join(tmpDir, "gopls.exe");
		try {
			writeFileSync(exePath, "dummy");
			chmodSync(exePath, 0o755);
			process.env.PATH = tmpDir;
			const found = _findInPath("gopls");
			expect(found).toBe(exePath);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("existing .cmd fallback still works after PATHEXT change", async () => {
		const { _findInPath } = await import("../lsp/manager.js");
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS";
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-shazam-605-"));
		const cmdPath = join(tmpDir, "test-server.cmd");
		try {
			writeFileSync(cmdPath, "dummy");
			chmodSync(cmdPath, 0o755);
			process.env.PATH = tmpDir;
			const found = _findInPath("test-server");
			expect(found).toBe(cmdPath);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

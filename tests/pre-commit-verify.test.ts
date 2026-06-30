/**
 * Tests for runPreCommitVerify diagnostic capture (issue #554).
 *
 * `tsc --noEmit`, `pyright`, and `mypy` emit their diagnostics to STDOUT,
 * but the previous stdio config (`["ignore", "ignore", "pipe"]`) discarded
 * stdout entirely. On non-zero exit, the pushed FAIL message carried only
 * an empty string from stderr, so the LLM/operator could not see which
 * type errors caused the failure.
 *
 * The fix changes the three affected call sites to
 * `stdio: ["ignore", "pipe", "pipe"]` and concatenates both `err.stdout`
 * and `err.stderr` into the pushed message. `cargo check` and `go vet`
 * already write to stderr and remain unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoisted mock so the factory can reference it at module-load time.
const { execImpl } = vi.hoisted(() => ({ execImpl: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		// runPreCommitVerify uses execFileSync for `git diff` and the compiler
		// checks. The dispatcher below routes by argv so a single mock covers
		// every call site.
		execFileSync: execImpl,
	};
});

import { runPreCommitVerify } from "../core/git-hooks.js";

let tmpDir: string;

beforeEach(() => {
	execImpl.mockReset();
	tmpDir = mkdtempSync(join(tmpdir(), "shazam-precommit-"));
	// Pre-create the project markers runPreCommitVerify probes for. tsconfig
	// triggers the TS branch; pyproject.toml triggers the Python branch.
	writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
	writeFileSync(join(tmpDir, "pyproject.toml"), "[tool.poetry]\n");
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build an execFileSync dispatcher that returns the staged-files list for
 * `git diff` and delegates to per-command handlers for the compiler probes.
 */
function dispatch(handlers: Record<string, (args: string[]) => unknown>) {
	execImpl.mockImplementation((cmd: string, args: string[]) => {
		if (cmd === "git" && args[0] === "diff") {
			// Pretend one file is staged so runPreCommitVerify runs the checks.
			return "src/staged-file.ts\n";
		}
		const key = handlers[`__cmd_${cmd}`] ? `__cmd_${cmd}` : `__cmd_${cmd}_${args.join("_")}`;
		const handler = handlers[key] ?? handlers[`__cmd_${cmd}`];
		if (handler) return handler(args);
		return "";
	});
}

/**
 * Build an execFileSync error object that mirrors what Node throws when a
 * child exits non-zero with stdio captured: `status`, `stdout`, `stderr`.
 */
function childError(stdout: string, stderr = "") {
	const err = new Error("Command failed");
	// Node's execFileSync attaches these as own properties.
	Object.assign(err, { status: 1, stdout, stderr });
	return err;
}

describe("issue #554: tsc stdout is captured into the FAIL message", () => {
	it("surfaces TSXXXX diagnostics from stdout (was empty before fix)", () => {
		const tscStdout = "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";
		dispatch({
			__cmd_npx: () => {
				throw childError(tscStdout, "");
			},
		});

		const result = runPreCommitVerify(tmpDir);

		expect(result.verdict).toBe("FAIL");
		expect(result.message).toContain("TypeScript typecheck failed");
		// The diagnostic text must reach the message (was "" before fix).
		expect(result.message).toContain("TS2322");
		expect(result.message).toContain("Type 'string' is not assignable");
	});
});

describe("issue #554: pyright stdout is captured into the FAIL message", () => {
	it("surfaces pyright diagnostics from stdout (was empty before fix)", () => {
		const pyrightStdout = "src/bar.py:10: error: Incompatible types (reportGeneralTypeIssues)\n";
		dispatch({
			__cmd_npx: () => "", // tsc passes (no tsconfig would skip, but we created one)
			__cmd_pyright: () => {
				throw childError(pyrightStdout, "");
			},
		});

		const result = runPreCommitVerify(tmpDir);

		expect(result.verdict).toBe("FAIL");
		expect(result.message).toContain("pyright");
		expect(result.message).toContain("Incompatible types");
	});
});

describe("issue #554: mypy stdout is captured into the FAIL message", () => {
	it("surfaces mypy diagnostics from stdout when pyright is unavailable (was empty before fix)", () => {
		// First Python probe: pyright ENOENT (not installed).
		// Second Python probe: mypy fails with stdout diagnostics.
		const mypyStdout = 'src/baz.py:15: error: Argument 1 has incompatible type "str"; expected "int"\n';
		const enoentErr = Object.assign(new Error("pyright: not found"), { code: "ENOENT", status: 127 });
		dispatch({
			__cmd_npx: () => "", // tsc passes
			__cmd_pyright: () => {
				throw enoentErr;
			},
			__cmd_mypy: () => {
				throw childError(mypyStdout, "");
			},
		});

		const result = runPreCommitVerify(tmpDir);

		expect(result.verdict).toBe("FAIL");
		expect(result.message).toContain("Python");
		expect(result.message).toContain("incompatible type");
	});
});

describe("issue #554: stderr-only tools (cargo, go vet) still work", () => {
	it("cargo stderr is still surfaced (regression guard)", () => {
		rmSync(join(tmpDir, "tsconfig.json"), { force: true });
		rmSync(join(tmpDir, "pyproject.toml"), { force: true });
		writeFileSync(join(tmpDir, "Cargo.toml"), '[package]\nname="x"\n');
		const cargoStderr = "error[E0277]: the trait bound is not satisfied\n";
		dispatch({
			__cmd_cargo: () => {
				throw childError("", cargoStderr);
			},
		});

		const result = runPreCommitVerify(tmpDir);

		expect(result.verdict).toBe("FAIL");
		expect(result.message).toContain("cargo check failed");
		expect(result.message).toContain("E0277");
	});
});

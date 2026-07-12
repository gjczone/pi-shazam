/**
 * Regression tests for shell-hook P0 fixes: #750, #751, #753.
 *
 * #750: every hook must source shazam-common.sh via a layout-resilient
 *       resolver (sibling `lib/` then `../lib/`) so the destructive-command
 *       guard actually loads in BOTH the source tree and the deployed flat
 *       layout. A broken source path makes the hook fail-open (AGENTS.md #728).
 * #751: shazam-common.sh must default SHAZAM_WATCHDOG_DIR/SHAZAM_LOG_DIR to
 *       /tmp (else branch) and export unprefixed WATCHDOG_DIR/LOG_DIR aliases
 *       so existing hooks no longer crash under `set -u`.
 * #753: check-destructive.sh must block `rm -rf -- /` and `rm -rf "/"`
 *       (functionally identical to the already-blocked `rm -rf /`).
 *
 * Static checks run on every platform (filesystem only). Dynamic checks that
 * execute the bash hooks run where `bash` is available; the end-to-end
 * check-destructive.sh cases additionally require `jq` (present on the
 * ubuntu-latest CI runner, absent on macOS/Windows runners) and skip there.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const HOOKS_CB = resolve(ROOT, "hooks/codebuddy");
const HOOKS_KIMI = resolve(ROOT, "hooks/kimi");
const LIB = resolve(ROOT, "hooks/lib/shazam-common.sh");
const DEPLOY = resolve(ROOT, "scripts/deploy-hooks.sh");

function findBash(): string | null {
	if (process.platform !== "win32") {
		try {
			execFileSync("bash", ["-c", "true"]);
			return "bash";
		} catch {
			return null;
		}
	}
	for (const c of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) {
		if (existsSync(c)) return c;
	}
	return null;
}

function hasJq(): boolean {
	try {
		execFileSync(findBash() ?? "bash", ["-c", "command -v jq"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const bash = findBash();

/** Run check-destructive.sh with the given command; return its exit code. */
function runHookExit(hookPath: string, command: string): number {
	const json = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
	try {
		execFileSync(bash!, ["-c", `bash "${hookPath}"`], {
			input: json,
			stdio: ["pipe", "ignore", "ignore"],
		});
		return 0;
	} catch (e: unknown) {
		const status = (e as { status?: number }).status;
		return typeof status === "number" ? status : 1;
	}
}

describe("shell hooks (issues #750 #751 #753)", () => {
	// ── Static regression checks: run on every platform ──
	describe("static: fix is present in source", () => {
		it("#750 every hook uses the layout-resilient lib resolver", () => {
			for (const dir of [HOOKS_CB, HOOKS_KIMI]) {
				for (const f of readdirSync(dir)) {
					if (!f.endsWith(".sh")) continue;
					const s = readFileSync(resolve(dir, f), "utf8");
					expect(s, `${f} should contain _SHAZAM_LIB resolver`).toContain("_SHAZAM_LIB=");
					expect(s, `${f} should not use the old parent-lib source`).not.toMatch(
						/source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\.\/lib\/shazam-common\.sh"/,
					);
					expect(s, `${f} should not use the old sibling-lib source line`).not.toContain(
						'source "$(dirname "${BASH_SOURCE[0]}")/lib/shazam-common.sh"',
					);
				}
			}
		});

		it("#750 deploy-hooks.sh asserts lib resolution for every hook", () => {
			const s = readFileSync(DEPLOY, "utf8");
			expect(s).toContain("lib resolves for");
			expect(s).toContain('resolved="$(dirname "$f")/lib/shazam-common.sh"');
		});

		it("#751 shazam-common.sh exports WATCHDOG_DIR/LOG_DIR with /tmp fallback", () => {
			const s = readFileSync(LIB, "utf8");
			expect(s).toContain('SHAZAM_WATCHDOG_DIR="${SHAZAM_WATCHDOG_DIR:-/tmp}"');
			expect(s).toContain('SHAZAM_LOG_DIR="${SHAZAM_LOG_DIR:-/tmp}"');
			expect(s).toContain("export WATCHDOG_DIR LOG_DIR");
		});

		it("#753 check-destructive.sh regex blocks quoted / -- variants", () => {
			for (const p of [resolve(HOOKS_CB, "check-destructive.sh"), resolve(HOOKS_KIMI, "check-destructive.sh")]) {
				const s = readFileSync(p, "utf8");
				expect(s, "should allow optional -- separator").toContain("([[:space:]]+--)?");
				// The file stores the quote char class via bash's `'"'"'` escape,
				// so the literal on disk is `["'"'"']?/`.
				expect(s, "should allow optional quote before /").toContain("[\"'\"'\"']?/");
			}
		});
	});

	// ── Dynamic checks: need bash ──
	const maybe = bash ? describe : describe.skip;
	maybe("dynamic: hook behavior (bash available)", () => {
		it("#751 sourcing shazam-common.sh sets WATCHDOG_DIR/LOG_DIR (else -> /tmp)", () => {
			const out = execFileSync(bash!, ["-c", `set -u; source "${LIB}"; echo "W=$WATCHDOG_DIR L=$LOG_DIR"`], {
				encoding: "utf8",
			});
			expect(out).toContain("W=/tmp");
			expect(out).toContain("L=/tmp");
		});

		// Deploy to a temp HOME so the source-resolution assertion runs against
		// the real deployed flat layout (validates the resolver end-to-end).
		let tmpHome: string | null = null;
		afterAll(() => {
			if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
		});

		it("#750 deploy --apply resolves lib for every hook (PASS, no FAIL)", () => {
			tmpHome = mkdtempSync(resolve(ROOT, "tests/.sh-deploy-XXXXXX"));
			// deploy-hooks.sh copies into these dirs but does not create them;
			// a real deployment assumes the platform created them. Set them up.
			mkdirSync(`${tmpHome}/.codebuddy/hooks/lib`, { recursive: true });
			mkdirSync(`${tmpHome}/.kimi-code/hooks/lib`, { recursive: true });
			const out = execFileSync(bash!, [DEPLOY, "--apply"], {
				encoding: "utf8",
				env: { ...process.env, HOME: tmpHome },
			});
			expect(out).toContain("lib resolves for check-destructive.sh");
			expect(out).not.toContain("[FAIL]");
		});

		// End-to-end check-destructive.sh cases require jq for JSON parsing.
		const jqMaybe = hasJq() ? describe : describe.skip;
		jqMaybe("check-destructive.sh blocks root rm (needs jq)", () => {
			const cases: Array<[string, number]> = [
				["rm -rf /", 2],
				["rm -rf -- /", 2],
				['rm -rf "/"', 2],
				["rm -fr /", 2],
				["rm --recursive --force /", 2],
				["safe && rm -rf /", 2],
				["rm -rf ./dist", 0],
			];
			for (const [cmd, want] of cases) {
				it(`'${cmd}' -> exit ${want}`, () => {
					expect(runHookExit(resolve(HOOKS_CB, "check-destructive.sh"), cmd)).toBe(want);
				});
			}
			it("kimi mirror also blocks 'rm -rf -- /'", () => {
				expect(runHookExit(resolve(HOOKS_KIMI, "check-destructive.sh"), "rm -rf -- /")).toBe(2);
			});
		});
	});
});

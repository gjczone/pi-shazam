/**
 * pi-shazam -- Pi coding agent native codebase awareness extension.
 *
 * Entry point. Registered as a default export.
 *
 * Layers:
 *   hooks/  -> tools/  -> core/ + lsp/
 *
 * Core has zero Pi or LSP imports. LSP may import from core.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "./types/pi-extension.js";
import { LspManager } from "./lsp/manager.js";
import { generateSetupReport, generateSetupSummary } from "./lsp/setup.js";
import { setLspManager, awaitPreviousShutdown } from "./tools/_context.js";
import { installPreCommitHook, isPreCommitHookInstalled } from "./core/git-hooks.js";
import { isProjectDir } from "./core/git-utils.js";
import { setProjectRoot as scannerSetProjectRoot } from "./core/scanner.js";
import { _logWarn, _logInternal } from "./core/output.js";
import { isHomeDirectory } from "./core/path-utils.js";

// -- Hook registrations ---------------------------------------------------
import { registerBeforeStartHook } from "./hooks/before-start.js";
import { registerToolLogger } from "./hooks/tool-logger.js";
import { registerShazamGuide } from "./hooks/shazam-guide.js";
import { registerPreEditGuard } from "./hooks/pre-edit.js";
import { registerPrecommitVerify } from "./hooks/precommit-verify.js";
import { registerStopVerify } from "./hooks/stop-verify.js";
import { registerFailureRecovery } from "./hooks/failure-recovery.js";
import { registerIssueGuard } from "./hooks/issue-guard.js";
import { registerAgentContextGuard } from "./hooks/agent-context-guard.js";
import { clearRenameState } from "./tools/rename-state.js";

// -- Tool registrations ----------------------------------------------------
import { registerOverview } from "./tools/overview.js";
import { registerLookup } from "./tools/lookup.js";
import { registerImpact } from "./tools/impact.js";
import { registerVerify } from "./tools/verify.js";
import { registerChanges } from "./tools/changes.js";
import { registerFormat } from "./tools/format.js";

import { registerRenameSymbol } from "./tools/rename_symbol.js";

export default async function (pi: ExtensionAPI): Promise<void> {
	let projectRoot = process.cwd();
	const log = (msg: string) => {
		pi.logger?.info?.(`[pi-shazam] ${msg}`);
	};
	// Issue #720: warn (not info) so the user actually sees it. The home
	// guard fires only on misconfiguration, so a warn level is appropriate.
	const warn = (msg: string) => {
		pi.logger?.warn?.(`[pi-shazam] ${msg}`);
	};

	// Issue #720: refuse to operate on the user's home directory by default.
	// Home trees are 10-100 GB / tens of thousands of dirs and would block
	// agent startup. Opt in with PI_SHAZAM_ALLOW_HOME=1, or simply `cd` into
	// a specific project subdirectory before launching. We log a clear
	// guidance message but do NOT abort -- the user may still want the
	// extension to load other hooks (e.g. issue-guard). The scanner-side
	// deadline in `_walkDirectory` caps latency even if the guard is bypassed.
	if (process.env.PI_SHAZAM_ALLOW_HOME !== "1" && isHomeDirectory(projectRoot)) {
		warn(
			`Refusing to scan home directory ${projectRoot}. ` +
				`Set PI_SHAZAM_ALLOW_HOME=1 to opt in, or change cwd to a project directory.`,
		);
	}

	// -- LSP manager ---------------------------------------------------------

	const lspManager = new LspManager(projectRoot, log);

	// Share LspManager with tools via global reference
	await setLspManager(lspManager);

	// Auto-initialize LSP on agent start (with overall 15s timeout guard).
	// IMPORTANT: This handler MUST be registered before registerBeforeStartHook.
	// Only the before-start handler returns { systemPrompt }; ordering matters.
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			// Update projectRoot from Pi's detected project directory when it
			// differs from process.cwd(). Handles the case where pi is started
			// from a parent directory but detects the project in a subdirectory
			// (issue #241). The home guard at the top of this module only
			// checked process.cwd(); re-check the new root here so a Pi-detected
			// cwd under $HOME also surfaces the warning (issue #720).
			if (ctx.cwd && ctx.cwd !== projectRoot) {
				projectRoot = ctx.cwd;
				lspManager.setProjectRoot(ctx.cwd);
				scannerSetProjectRoot(ctx.cwd);
				log(`Project root updated from Pi context: ${ctx.cwd}`);
				if (process.env.PI_SHAZAM_ALLOW_HOME !== "1" && isHomeDirectory(ctx.cwd)) {
					warn(
						`Refusing to scan home directory ${ctx.cwd}. ` +
							`Set PI_SHAZAM_ALLOW_HOME=1 to opt in, or change cwd to a project directory.`,
					);
				}
			}

			await awaitPreviousShutdown();
			const languages = lspManager.detectLanguages();
			if (languages.length > 0) {
				log(`Detected languages: ${languages.join(", ")}`);
				let initTimer: NodeJS.Timeout | undefined;
				try {
					await Promise.race([
						lspManager.initializeAll(),
						new Promise<void>((_, reject) => {
							initTimer = setTimeout(() => reject(new Error("LSP initialization timed out after 15s")), 15000);
						}),
					]);
				} finally {
					if (initTimer) clearTimeout(initTimer);
				}
			}
		} catch (err) {
			const isTimeout = err instanceof Error && err.message.includes("timed out");
			if (isTimeout) {
				// On timeout, clean up any partially-spawned LSP processes
				// to prevent orphaned processes until session_shutdown (fixes #312).
				try {
					await lspManager.shutdown();
				} catch (err) {
					_logWarn("lspInitTimeout", "LSP shutdown on init timeout failed", err);
				}
			}
			log(`LSP init error: ${err}`);
		}
	});

	// Shutdown LSP servers on session shutdown
	pi.on("session_shutdown", async () => {
		try {
			log("Shutting down LSP servers...");
			await lspManager.shutdown();
		} catch (err) {
			_logWarn("sessionShutdown", "LSP shutdown failed", err);
		}
		// Clean up module-level caches to prevent memory leaks
		try {
			const { resetCache } = await import("./core/scanner.js");
			resetCache();
		} catch (err) {
			_logWarn("sessionShutdown", "scanner cache reset failed", err);
		}
		try {
			const { resetLspEnrichState } = await import("./tools/lsp_enrich.js");
			resetLspEnrichState();
		} catch (err) {
			_logWarn("sessionShutdown", "lsp enrich state reset failed", err);
		}
		try {
			const { resetBaseline } = await import("./core/baseline.js");
			resetBaseline();
		} catch (err) {
			_logWarn("sessionShutdown", "baseline reset failed", err);
		}
		// Reset the rename safety-gate state so a stale "call-chain-checked"
		// Set does not persist across crash recovery, hot reload, or any
		// session boundary that fires session_shutdown without a preceding
		// session_start (issue #548). Without this, shazam_rename_symbol
		// could bypass the impact-call gate based on the prior session's
		// reviewed symbols.
		try {
			clearRenameState();
		} catch (err) {
			_logWarn("sessionShutdown", "rename state reset failed", err);
		}
	});

	// Reset rename safety gate state on new session (issue #326).
	// Also auto-report LSP setup status and auto-install git pre-commit hook
	// so the user gets a fully configured project without running any commands.
	pi.on("session_start", (_event, ctx) => {
		clearRenameState();

		// Auto-report LSP server availability
		try {
			const summary = generateSetupSummary(projectRoot);

			// Status bar — persistent indicator, always visible
			ctx.ui.setStatus("lsp", summary.statusText);

			// Toast + chat report — only when LSP is not fully ready
			if (!summary.allPass) {
				ctx.ui.notify(summary.notifyMessage, summary.notifyType);
				const report = generateSetupReport(projectRoot);
				pi.sendMessage({
					customType: "shazam-setup",
					content: report,
					display: true,
				});
			}
		} catch (err) {
			_logWarn("auto-setup", "Failed to generate LSP setup report", err);
		}

		// Auto-install git pre-commit hook. Skip entirely when projectRoot is
		// not a project directory (no git repo, no marker files) so we
		// do not emit confusing "git rev-parse failed" warnings when the
		// Pi-detected cwd sits somewhere unintended (e.g. $HOME under
		// the issue #720 home guard).
		try {
			if (isProjectDir(projectRoot) && !isPreCommitHookInstalled(projectRoot)) {
				installPreCommitHook(projectRoot);
				log("Git pre-commit hook auto-installed");
			}
		} catch (err) {
			// Silently skip — hook managers (husky/lefthook) or non-git projects
			_logWarn("auto-git-hooks", "Git hook auto-install skipped", err);
		}
	});

	// -- Hooks ----------------------------------------------------------------
	registerBeforeStartHook(pi);
	registerToolLogger(pi);
	registerShazamGuide(pi);
	registerPreEditGuard(pi);
	registerPrecommitVerify(pi);
	registerStopVerify(pi);
	registerFailureRecovery(pi);
	registerIssueGuard(pi);
	registerAgentContextGuard(pi);

	// -- /shazam-doctor command ----------------------------------------------

	pi.registerCommand("shazam-doctor", {
		description: "Health check: tree-sitter grammars, LSP servers, cache integrity, recent diagnostics",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const lspReport = generateSetupReport(projectRoot);
			const parts: string[] = ["## Shazam Doctor - Health Check", "", lspReport];

			// Read recent entries from internal.log
			try {
				const { readFileSync, existsSync } = await import("node:fs");
				const { join } = await import("node:path");
				const { homedir } = await import("node:os");
				const internalLogPath = join(homedir(), ".pi", "hooks", "audit", "internal.log");
				const callsLogPath = join(homedir(), ".pi", "hooks", "audit", "shazam-calls.log");

				// Recent errors from internal.log
				if (existsSync(internalLogPath)) {
					const content = readFileSync(internalLogPath, "utf-8");
					const lines = content.trim().split("\n").filter(Boolean);
					const recent = lines.slice(-50);
					const errors = recent
						.map((l) => {
							try {
								const parsed = JSON.parse(l);
								return parsed.err || parsed.level === "error" ? parsed : null;
							} catch (err) {
								_logWarn("shazam-doctor", "JSON.parse failed for internal.log line", err);
								return null;
							}
						})
						.filter(Boolean)
						.slice(-3);

					if (errors.length > 0) {
						parts.push("", "### Recent Errors", "");
						for (const e of errors) {
							parts.push(`- ${e.ts}: ${e.message || JSON.stringify(e).slice(0, 100)}`);
						}
					}

					// Recent slow calls from shazam-calls.log
					if (existsSync(callsLogPath)) {
						const callsContent = readFileSync(callsLogPath, "utf-8");
						const callLines = callsContent.trim().split("\n").filter(Boolean);
						const recentCalls = callLines.slice(-50);
						const slowCalls = recentCalls
							.map((l) => {
								try {
									const parsed = JSON.parse(l);
									if (parsed.event === "result" && parsed.durationMs > 500) return parsed;
									return null;
								} catch (err) {
									_logWarn("shazam-doctor", "JSON.parse failed for shazam-calls.log line", err);
									return null;
								}
							})
							.filter(Boolean)
							.slice(-3);

						if (slowCalls.length > 0) {
							parts.push("", "### Recent Slow Calls (>500ms)", "");
							for (const c of slowCalls) {
								const timing = c.nestedTiming
									? ` - bottleneck: ${Object.entries(c.nestedTiming as Record<string, number>).sort((a, b) => b[1] - a[1])[0]?.[0]} (${Object.entries(c.nestedTiming as Record<string, number>).sort((a, b) => b[1] - a[1])[0]?.[1]}ms)`
									: "";
								parts.push(`- ${c.tool}: ${c.durationMs}ms${timing}`);
							}
						}
					}
				}
			} catch (err) {
				_logWarn("shazam-doctor", "log analysis failed", err as Error);
			}

			const msg = parts.join("\n");
			ctx.ui?.setStatus?.("shazam-doctor", "Health check complete");
			pi.sendMessage({
				customType: "shazam-doctor",
				content: msg,
				display: true,
			});
		},
	});

	// -- Tools (LLM-visible) ------------------------------------------------
	registerOverview(pi);
	registerLookup(pi);
	registerImpact(pi);
	registerVerify(pi);
	registerChanges(pi);
	registerFormat(pi);

	registerRenameSymbol(pi);

	log("pi-shazam loaded");
}

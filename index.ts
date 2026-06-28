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
import {
	installPreCommitHook,
	isPreCommitHookInstalled,
	removePreCommitHook,
	runPreCommitVerify,
} from "./core/git-hooks.js";
import { setProjectRoot as scannerSetProjectRoot } from "./core/scanner.js";
import { _logWarn } from "./core/output.js";

// -- Hook registrations ---------------------------------------------------
import { registerBeforeStartHook } from "./hooks/before-start.js";
import { registerToolLogger } from "./hooks/tool-logger.js";
import { registerShazamGuide } from "./hooks/shazam-guide.js";
import { registerPreEditGuard } from "./hooks/pre-edit.js";
import { registerSafetyHooks } from "./hooks/safety.js";
import { registerStopVerify } from "./hooks/stop-verify.js";
import { registerFailureRecovery } from "./hooks/failure-recovery.js";
import { registerIssueGuard } from "./hooks/issue-guard.js";
import { registerAgentContextGuard } from "./hooks/agent-context-guard.js";
import { clearRenameState } from "./hooks/rename-state.js";

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
			// (issue #241).
			if (ctx.cwd && ctx.cwd !== projectRoot) {
				projectRoot = ctx.cwd;
				lspManager.setProjectRoot(ctx.cwd);
				scannerSetProjectRoot(ctx.cwd);
				log(`Project root updated from Pi context: ${ctx.cwd}`);
			}

			await awaitPreviousShutdown();
			const languages = lspManager.detectLanguages();
			if (languages.length > 0) {
				log(`Detected languages: ${languages.join(", ")}`);
				await Promise.race([
					lspManager.initializeAll(),
					new Promise<void>((_, reject) =>
						setTimeout(() => reject(new Error("LSP initialization timed out after 15s")), 15000),
					),
				]);
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
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error(`[pi-shazam] session_shutdown: LSP shutdown failed: ${errMsg}`);
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

		// Auto-install git pre-commit hook
		try {
			if (!isPreCommitHookInstalled(projectRoot)) {
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
	registerSafetyHooks(pi);
	registerStopVerify(pi);
	registerFailureRecovery(pi);
	registerIssueGuard(pi);
	registerAgentContextGuard(pi);

	// -- /shazam-setup command -----------------------------------------------

	pi.registerCommand("shazam-setup", {
		description: "Detect and report LSP server availability with install instructions",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const report = generateSetupReport(projectRoot);
			ctx.ui?.setStatus?.("shazam-setup", "LSP setup report generated");
			// Send as a custom message so the user sees the report
			pi.sendMessage({
				customType: "shazam-setup",
				content: report,
				display: true,
			});
		},
	});

	// -- /shazam-doctor command ----------------------------------------------

	pi.registerCommand("shazam-doctor", {
		description: "Health check: tree-sitter grammars, LSP servers, cache integrity",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const lspReport = generateSetupReport(projectRoot);
			const msg = ["## Shazam Doctor - Health Check", "", lspReport].join("\n");
			ctx.ui?.setStatus?.("shazam-doctor", "Health check complete");
			pi.sendMessage({
				customType: "shazam-doctor",
				content: msg,
				display: true,
			});
		},
	});

	// -- /shazam-install-git-hooks command ------------------------------------

	pi.registerCommand("shazam-install-git-hooks", {
		description: "Install git pre-commit hook that runs shazam_verify --preCommit",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			try {
				const hookPath = installPreCommitHook(projectRoot);
				const msg = [
					"## Git Pre-Commit Hook Installed",
					"",
					`Hook installed at: \`${hookPath}\``,
					"",
					"This hook runs shazam verification before every commit.",
					"To bypass: \`git commit --no-verify\`",
					"To uninstall: \`/shazam-remove-git-hooks\`",
				].join("\n");
				ctx.ui?.setStatus?.("shazam-install-git-hooks", "Git pre-commit hook installed");
				pi.sendMessage({ customType: "shazam-install-git-hooks", content: msg, display: true });
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				pi.sendMessage({
					customType: "shazam-install-git-hooks",
					content: `Failed to install git hook: ${errMsg}`,
					display: true,
				});
			}
		},
	});

	// -- /shazam-remove-git-hooks command -------------------------------------

	pi.registerCommand("shazam-remove-git-hooks", {
		description: "Remove the shazam git pre-commit hook",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const removed = removePreCommitHook(projectRoot);
			if (removed) {
				const msg = [
					"## Git Pre-Commit Hook Removed",
					"",
					"The shazam pre-commit hook has been removed.",
					"Your original hook (if any) has been restored.",
				].join("\n");
				ctx.ui?.setStatus?.("shazam-remove-git-hooks", "Git pre-commit hook removed");
				pi.sendMessage({ customType: "shazam-remove-git-hooks", content: msg, display: true });
			} else {
				pi.sendMessage({
					customType: "shazam-remove-git-hooks",
					content: "No shazam pre-commit hook found to remove.",
					display: true,
				});
			}
		},
	});

	// -- /shazam-pre-commit-verify command (for hook script) ------------------

	pi.registerCommand("shazam-pre-commit-verify", {
		description: "Run pre-commit verification (used by git hook)",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const result = runPreCommitVerify(projectRoot);
			const msg = ["## Pre-Commit Verification", "", `Verdict: ${result.verdict}`, `${result.message}`].join("\n");
			ctx.ui?.setStatus?.("shazam-pre-commit-verify", `Pre-commit verify: ${result.verdict}`);
			pi.sendMessage({ customType: "shazam-pre-commit-verify", content: msg, display: true });
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

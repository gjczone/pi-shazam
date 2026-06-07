/**
 * pi-shazam — Pi coding agent native codebase awareness extension.
 *
 * Entry point. Registered as a default export.
 *
 * Layers:
 *   hooks/  → tools/  → core/ + lsp/
 *
 * Core has zero Pi or LSP imports. LSP may import from core.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "./types/pi-extension.js";
import { LspManager } from "./lsp/manager.js";
import { generateSetupReport } from "./lsp/setup.js";
import { setLspManager } from "./tools/_context.js";
import { installPreCommitHook, removePreCommitHook, runPreCommitVerify } from "./core/git-hooks.js";

// ── Hook registrations ───────────────────────────────────────────────────
import { registerBeforeStartHook } from "./hooks/before-start.js";
import { registerToolLogger } from "./hooks/tool-logger.js";
import { registerShazamGuide } from "./hooks/shazam-guide.js";
import { registerPreEditGuard } from "./hooks/pre-edit.js";

// ── Tool registrations ────────────────────────────────────────────────────
import { registerOverview } from "./tools/overview.js";
import { registerImpact } from "./tools/impact.js";
import { registerCallChain } from "./tools/call_chain.js";
import { registerVerify } from "./tools/verify.js";
import { registerFix } from "./tools/fix.js";
import { registerHotspots } from "./tools/hotspots.js";
import { registerCodesearch } from "./tools/codesearch.js";
import { registerFileDetail } from "./tools/file_detail.js";
import { registerSymbol } from "./tools/symbol.js";
import { registerHover } from "./tools/hover.js";
import { registerFindTests } from "./tools/find_tests.js";
import { registerTypeHierarchy } from "./tools/type_hierarchy.js";
import { registerRenameSymbol } from "./tools/rename_symbol.js";
import { registerSafeDelete } from "./tools/safe_delete.js";

export default function (pi: ExtensionAPI): void {
	const projectRoot = process.cwd();
	const log = (msg: string) => {
		if (pi.logger?.info) pi.logger.info(`[pi-shazam] ${msg}`);
	};

	// ── LSP manager ─────────────────────────────────────────────────────────

	const lspManager = new LspManager(projectRoot, log);

	// Share LspManager with tools via global reference
	setLspManager(lspManager);

	// Auto-initialize LSP on agent start (with overall 15s timeout guard)
	pi.on("before_agent_start", async (_event, _ctx) => {
		try {
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
	});

	// ── Hooks ────────────────────────────────────────────────────────────────
	registerBeforeStartHook(pi);
	registerToolLogger(pi);
	registerShazamGuide(pi);
	registerPreEditGuard(pi);

	// ── /shazam-setup command ───────────────────────────────────────────────

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

	// ── /shazam-doctor command ──────────────────────────────────────────────

	pi.registerCommand("shazam-doctor", {
		description: "Health check: tree-sitter grammars, LSP servers, cache integrity",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const lspReport = generateSetupReport(projectRoot);
			const msg = ["## Shazam Doctor — Health Check", "", lspReport].join("\n");
			ctx.ui?.setStatus?.("shazam-doctor", "Health check complete");
			pi.sendMessage({
				customType: "shazam-doctor",
				content: msg,
				display: true,
			});
		},
	});

	// ── /shazam-install-git-hooks command ────────────────────────────────────

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

	// ── /shazam-remove-git-hooks command ─────────────────────────────────────

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

	// ── /shazam-pre-commit-verify command (for hook script) ──────────────────

	pi.registerCommand("shazam-pre-commit-verify", {
		description: "Run pre-commit verification (used by git hook)",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const result = runPreCommitVerify(projectRoot);
			const msg = [
				"## Pre-Commit Verification",
				"",
				`Verdict: ${result.verdict}`,
				`${result.message}`,
			].join("\n");
			ctx.ui?.setStatus?.("shazam-pre-commit-verify", `Pre-commit verify: ${result.verdict}`);
			pi.sendMessage({ customType: "shazam-pre-commit-verify", content: msg, display: true });
		},
	});

	// ── Tools (LLM-visible) ────────────────────────────────────────────────
	registerOverview(pi);
	registerImpact(pi);
	registerCallChain(pi);
	registerVerify(pi);
	registerFix(pi);
	registerHotspots(pi);
	registerCodesearch(pi);
	registerFileDetail(pi);
	registerSymbol(pi);
	registerHover(pi);
	registerFindTests(pi);
	registerTypeHierarchy(pi);
	registerRenameSymbol(pi);
	registerSafeDelete(pi);

	log("pi-shazam loaded");
}

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

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "./types/pi-extension.js";
import { LspManager } from "./lsp/manager.js";
import { generateSetupReport } from "./lsp/setup.js";
import { setLspManager } from "./tools/_context.js";

// ── Hook registrations ───────────────────────────────────────────────────
import { registerBeforeStartHook } from "./hooks/before-start.js";
import { registerAfterWriteHook } from "./hooks/after-write.js";
import { registerToolLogger } from "./hooks/tool-logger.js";
import { registerShazamGuide } from "./hooks/shasam-guide.js";

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

	// Auto-initialize LSP on agent start
	pi.on("before_agent_start", async (_event, _ctx) => {
		try {
			const languages = lspManager.detectLanguages();
			if (languages.length > 0) {
				log(`Detected languages: ${languages.join(", ")}`);
				await lspManager.initializeAll();
			}
		} catch (err) {
			log(`LSP init error: ${err}`);
		}
	});

	// Shutdown LSP servers on session shutdown
	pi.on("session_shutdown", async () => {
		log("Shutting down LSP servers...");
		await lspManager.shutdown();
	});

	// ── Hooks ────────────────────────────────────────────────────────────────
	registerBeforeStartHook(pi);
	registerAfterWriteHook(pi);
	registerToolLogger(pi);
	registerShazamGuide(pi);

	// ── /shazam-setup command ───────────────────────────────────────────────

	pi.registerCommand("shazam-setup", {
		description:
			"Detect and report LSP server availability with install instructions",
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
		description:
			"Health check: tree-sitter grammars, LSP servers, cache integrity",
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

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

import type { ExtensionAPI, ExtensionContext } from "./types/pi-extension.js";
import { LspManager } from "./lsp/manager.js";
import { generateSetupReport } from "./lsp/setup.js";

export default function (pi: ExtensionAPI): void {
	const projectRoot = process.cwd();
	const log = (msg: string) => pi.logger.info(`[pi-shazam] ${msg}`);

	// ── LSP manager ─────────────────────────────────────────────────────────

	const lspManager = new LspManager(projectRoot, log);

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
	pi.on("session_shutdown", () => {
		log("Shutting down LSP servers...");
		lspManager.shutdown();
	});

	// ── /shazam-setup command ───────────────────────────────────────────────

	pi.registerCommand("shazam-setup", {
		description: "Detect and report LSP server availability with install instructions",
		async handler(_args: string, ctx: ExtensionContext) {
			const report = generateSetupReport(projectRoot);
			ctx.ui.setStatus("shazam-setup", "LSP setup report generated");
			// Send as a custom message so the user sees the report
			pi.sendMessage({
				customType: "shazam-setup",
				content: [{ type: "text", text: report }],
				display: true,
			});
		},
	});

	// ── /shazam-doctor command ──────────────────────────────────────────────

	pi.registerCommand("shazam-doctor", {
		description: "Health check: tree-sitter grammars, LSP servers, cache integrity",
		async handler(_args: string, ctx: ExtensionContext) {
			const lspReport = generateSetupReport(projectRoot);
			const msg = [
				"## Shazam Doctor — Health Check",
				"",
				lspReport,
			].join("\n");
			ctx.ui.setStatus("shazam-doctor", "Health check complete");
			pi.sendMessage({
				customType: "shazam-doctor",
				content: [{ type: "text", text: msg }],
				display: true,
			});
		},
	});

	log("pi-shazam loaded");
}

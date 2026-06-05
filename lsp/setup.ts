/**
 * pi-shazam lsp/setup — /shazam-setup command: detect + install guidance.
 *
 * Scans the project for supported languages, detects installed LSP servers,
 * and outputs install instructions for missing ones.
 *
 * Ported from repomap/src/lsp.py (detect_lsp_servers and CLI output formatting).
 */

import { detectLspServer, detectProjectLanguages } from "./manager.js";
import type { LspServerDetection } from "./manager.js";

// ── Install instructions ─────────────────────────────────────────────────────

interface InstallInstruction {
	language: string;
	serverName: string;
	packages: string[];
	commands: string[];
}

const INSTALL_INSTRUCTIONS: InstallInstruction[] = [
	{
		language: "python",
		serverName: "pyright-langserver",
		packages: ["pyright"],
		commands: ["npm install -g pyright", "pip install pyright"],
	},
	{
		language: "python",
		serverName: "pylsp",
		packages: ["python-lsp-server"],
		commands: [
			"pip install python-lsp-server",
			"pipx install python-lsp-server",
		],
	},
	{
		language: "typescript",
		serverName: "typescript-language-server",
		packages: ["typescript-language-server", "typescript"],
		commands: [
			"npm install -g typescript-language-server typescript",
		],
	},
	{
		language: "go",
		serverName: "gopls",
		packages: ["golang.org/x/tools/gopls"],
		commands: ["go install golang.org/x/tools/gopls@latest"],
	},
	{
		language: "json",
		serverName: "vscode-json-languageserver",
		packages: ["vscode-langservers-extracted"],
		commands: ["npm install -g vscode-langservers-extracted"],
	},
	{
		language: "yaml",
		serverName: "yaml-language-server",
		packages: ["yaml-language-server"],
		commands: [
			"npm install -g yaml-language-server",
		],
	},
	{
		language: "rust",
		serverName: "rust-analyzer",
		packages: ["rust-analyzer"],
		commands: [
			"rustup component add rust-analyzer",
			"brew install rust-analyzer",
		],
	},
];

// ── Re-export for convenience ────────────────────────────────────────────────

export type { LspServerDetection };

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Detect LSP servers for specified languages or auto-detect from project.
 */
export function detectLspServers(
	projectRoot: string,
	languages?: string[],
): LspServerDetection[] {
	const detected = languages ?? detectProjectLanguages(projectRoot);
	return detected.map((lang) => detectLspServer(projectRoot, lang));
}

// ── Setup command handler ────────────────────────────────────────────────────

/**
 * Generate the /shazam-setup output as a formatted string.
 */
export function generateSetupReport(
	projectRoot: string,
	languages?: string[],
): string {
	const detections = detectLspServers(projectRoot, languages);
	const available: LspServerDetection[] = [];
	const missing: LspServerDetection[] = [];

	for (const d of detections) {
		if (d.status === "available") {
			available.push(d);
		} else {
			missing.push(d);
		}
	}

	const lines: string[] = [];

	lines.push("## Shazam LSP Setup");
	lines.push("");
	lines.push(`Project: ${projectRoot}`);
	lines.push(`Detected languages: ${detections.map((d) => d.language).join(", ") || "none"}`);
	lines.push("");

	// Available servers
	if (available.length > 0) {
		lines.push("### ✅ Available LSP Servers");
		lines.push("");
		for (const d of available) {
			lines.push(
				`- **${d.language}**: \`${d.serverName}\` (${d.source}: \`${d.command.join(" ")}\`)`,
			);
		}
		lines.push("");
	}

	// Missing servers with install instructions
	if (missing.length > 0) {
		lines.push("### ❌ Missing LSP Servers");
		lines.push("");
		for (const d of missing) {
			const instruction = INSTALL_INSTRUCTIONS.find(
				(i) =>
					i.language === d.language &&
					i.serverName === d.serverName,
			);

			lines.push(`#### ${d.language} — ${d.serverName}`);
			if (d.reason) {
				lines.push(`  Reason: ${d.reason}`);
			}
			if (instruction) {
				lines.push("  Install:");
				for (const cmd of instruction.commands) {
					lines.push(`    ${cmd}`);
				}
			}
			lines.push("");
		}
	}

	if (detections.length === 0) {
		lines.push(
			"No supported languages detected in this project. LSP features will be unavailable.",
		);
	}

	return lines.join("\n");
}

/**
 * Get the install instructions as a simple key-value map
 * for use in tool outputs.
 */
export function getInstallInstructions(): Record<string, string[]> {
	const map: Record<string, string[]> = {};
	for (const inst of INSTALL_INSTRUCTIONS) {
		const key = `${inst.language}:${inst.serverName}`;
		map[key] = inst.commands;
	}
	return map;
}

/**
 * Guide the agent to use shazam tools at the right moments.
 *
 * Injects context reminders at key lifecycle points:
 * - before_agent_start: inject shazam tool list into system prompt
 * - tool_result (write/edit): auto-format + suggest running shazam_verify
 * - tool_result (shazam_symbol): suggest call_chain when symbol has many callers
 * - tool_call (shazam_impact): suggest running shazam_verify first
 * - tool_call (shazam_rename_symbol): suggest running shazam_call_chain first
 *
 * Auto-format feature (v0.6.4):
 * - After write/edit, detect file type and run native formatter
 * - Supported: ruff (Python), prettier (JS/TS/JSON/MD), gofmt (Go), rustfmt (Rust)
 * - Falls back to shazam_fix suggestion if no native formatter found
 */
import type { ExtensionAPI, ExtensionContext } from "../types/pi-extension.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * Check if a tool result contains caller count and suggest call_chain for high-risk symbols.
 */
function hasManyCallers(content: unknown[] | undefined): string | null {
	if (!content) return null;
	for (const item of content) {
		if (item && typeof item === "object" && "text" in item) {
			const text = (item as { text: string }).text;
			// Look for caller count patterns: "N callers" or "N references"
			const callerMatch = text.match(/(\d+) callers?/i);
			const refMatch = text.match(/(\d+) references?/i);
			const symbolMatch = text.match(/`([^`]+)`/);
			const symbolName = symbolMatch ? symbolMatch[1] : null;

			// Extract the actual number (callers is more precise than references)
			const count = callerMatch
				? parseInt(callerMatch[1], 10)
				: refMatch
					? parseInt(refMatch[1], 10)
					: 0;

			if (count >= 5 && symbolName) {
				return symbolName;
			}
		}
	}
	return null;
}

/**
 * Check if tool result mentions multiple changed files (for impact suggestion).
 */
function hasMultiFileEdit(content: unknown[] | undefined): boolean {
	if (!content) return false;
	for (const item of content) {
		if (item && typeof item === "object" && "text" in item) {
			const text = (item as { text: string }).text;
			const fileMatches = text.match(/(\d+) files?/gi);
			if (fileMatches) {
				for (const m of fileMatches) {
					const num = parseInt(m.match(/\d+/)?.[0] || "0", 10);
					if (num >= 2) return true;
				}
			}
		}
	}
	return false;
}

/**
 * Auto-format a file after write/edit.
 * Detects file type and runs the appropriate native formatter.
 * Returns true if formatting was attempted, false if no formatter found.
 */
async function autoFormatFile(filePath: string, ctx: ExtensionContext): Promise<boolean> {
	if (!filePath || typeof filePath !== "string") return false;

	// Resolve relative paths
	const absPath = filePath.startsWith("/") ? filePath : join(ctx.cwd, filePath);
	if (!existsSync(absPath)) return false;

	const ext = extname(absPath).toLowerCase();
	const projectRoot = ctx.cwd;

	try {
		// Python: ruff format
		if (ext === ".py") {
			const hasRuff =
				existsSync(join(projectRoot, "ruff.toml")) ||
				existsSync(join(projectRoot, "pyproject.toml"));
			if (hasRuff) {
				execFileSync("ruff", ["format", absPath], { cwd: projectRoot, timeout: 10000, stdio: "pipe" });
				ctx.ui.notify(`[auto-format] Formatted ${filePath} with ruff`, "info");
				return true;
			}
		}

		// JS/TS/JSON/MD/CSS: prettier
		if ([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".scss", ".html", ".yaml", ".yml", ".vue", ".svelte"].includes(ext)) {
			const hasPrettier =
				existsSync(join(projectRoot, ".prettierrc")) ||
				existsSync(join(projectRoot, ".prettierrc.json")) ||
				existsSync(join(projectRoot, ".prettierrc.js")) ||
				existsSync(join(projectRoot, "prettier.config.js")) ||
				existsSync(join(projectRoot, "prettier.config.mjs"));
			if (hasPrettier) {
				execFileSync("npx", ["prettier", "--write", absPath], { cwd: projectRoot, timeout: 15000, stdio: "pipe" });
				ctx.ui.notify(`[auto-format] Formatted ${filePath} with prettier`, "info");
				return true;
			}

			// Biome
			const hasBiome =
				existsSync(join(projectRoot, "biome.json")) ||
				existsSync(join(projectRoot, "biome.jsonc"));
			if (hasBiome) {
				execFileSync("npx", ["biome", "format", "--write", absPath], { cwd: projectRoot, timeout: 15000, stdio: "pipe" });
				ctx.ui.notify(`[auto-format] Formatted ${filePath} with biome`, "info");
				return true;
			}
		}

		// Go: gofmt
		if (ext === ".go") {
			execFileSync("gofmt", ["-w", absPath], { cwd: projectRoot, timeout: 10000, stdio: "pipe" });
			ctx.ui.notify(`[auto-format] Formatted ${filePath} with gofmt`, "info");
			return true;
		}

		// Rust: rustfmt
		if (ext === ".rs") {
			execFileSync("rustfmt", [absPath], { cwd: projectRoot, timeout: 10000, stdio: "pipe" });
			ctx.ui.notify(`[auto-format] Formatted ${filePath} with rustfmt`, "info");
			return true;
		}
	} catch (err) {
		// Formatter failed — warn but don't block
		ctx.ui.notify(
			`[auto-format] Formatter failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			"warning",
		);
		return true; // We attempted formatting
	}

	return false; // No formatter found
}

/**
 * Extract file path from tool input.
 */
function extractFilePath(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const obj = input as Record<string, unknown>;
	if (typeof obj.path === "string") return obj.path;
	if (typeof obj.file === "string") return obj.file;
	return null;
}

export function registerShazamGuide(pi: ExtensionAPI): void {
	// Tool list injection removed — the before-start hook's overview already
	// covers all tool guidance. Keeping only contextual lifecycle notifications.

	pi.on("tool_result", async (event, ctx) => {
		// After write/edit: auto-format + suggest verify + impact analysis
		if (event.toolName === "write" || event.toolName === "edit") {
			if (event.isError) return;

			// Auto-format the edited file
			const input = "input" in event ? (event as unknown as Record<string, unknown>).input : {};
			const filePath = extractFilePath(input);
			const formatted = filePath ? await autoFormatFile(filePath, ctx) : false;

			// If no native formatter found, suggest shazam_fix
			if (!formatted) {
				ctx.ui.notify(
					"run shazam_fix to auto-format (prettier/ruff/gofmt/rustfmt)",
					"info",
				);
			}

			// Check if multi-file edit was done — suggest impact analysis
			if (hasMultiFileEdit(event.content)) {
				ctx.ui.notify(
					"suggestion: you edited multiple files — shazam_impact assesses blast radius before continuing",
					"info",
				);
			}
			return;
		}

		// After shazam_symbol: suggest call_chain for symbols with many callers
		if (event.toolName === "shazam_symbol") {
			const symbolName = hasManyCallers(event.content);
			if (symbolName && !event.isError) {
				ctx.ui.notify(
					`recommended: shazam_call_chain --symbol ${symbolName} traces all callers before changing this symbol`,
					"info",
				);
			}
			return;
		}

		// After shazam_verify FAIL/WARN: suggest remediation
		if (event.toolName === "shazam_verify" && !event.isError) {
			const texts: string[] = [];
			if (event.content) {
				for (const c of event.content) {
					if (typeof c === "object" && "text" in c) texts.push((c as { text: string }).text);
				}
			}
			const combined = texts.join("\n");
			if (combined.includes("[FAIL]")) {
				ctx.ui.notify("shazam_verify reported FAIL — fix errors before proceeding", "warning");
			} else if (combined.includes("[WARN]")) {
				ctx.ui.notify("shazam_verify reported WARN — review warnings, then run shazam_fix if needed", "info");
			}
			return;
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const name = event.toolName;

		// Before impact: suggest verifying first if there are uncommitted changes
		if (name === "shazam_impact") {
			ctx.ui.notify("tip: run shazam_verify first to establish a baseline before assessing impact", "info");
			return;
		}

		// Before rename_symbol: suggest call_chain first
		if (name === "shazam_rename_symbol") {
			ctx.ui.notify("tip: run shazam_call_chain first to verify all references before renaming", "info");
			return;
		}
	});
}

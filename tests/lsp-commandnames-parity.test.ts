/**
 * Regression test for issue #457.
 *
 * Verifies the invariant: for every (server, install-command) pair in
 * lsp/setup.ts, at least one of the server's `commandNames` matches the
 * executable that the install command actually produces. This catches the
 * exact class of bug that #457 reported (the install command for JSON
 * installs a binary named `vscode-json-language-server` but the code only
 * searched for `vscode-json-languageserver`).
 *
 * The mapping is maintained as a small allowlist in this file because
 * installing every package to discover its real binary name is impractical
 * in a CI sandbox. The list is the single source of truth for the test --
 * when a new language is added, extend it here and in lsp/servers.ts.
 */
import { describe, it, expect } from "vitest";
import { LSP_SERVER_SPECS } from "../lsp/servers.js";
import { INSTALL_INSTRUCTIONS_INTERNAL } from "../lsp/setup.js";

/**
 * Map of npm/pip package -> the executable it installs.
 * For npm packages: the name of the binary placed on PATH after `npm i -g <pkg>`.
 * For pip packages: the console_script name.
 */
const PACKAGE_TO_BINARY: Record<string, string> = {
	// The "official" install package for JSON LSP. It ships 4 binaries,
	// the one we want is vscode-json-language-server.
	"vscode-langservers-extracted": "vscode-json-language-server",
	// Fallback npm package for the same language server
	"vscode-json-languageserver": "vscode-json-languageserver",
	typescript: "typescript-language-server",
	"typescript-language-server": "typescript-language-server",
	pyright: "pyright-langserver",
	"python-lsp-server": "pylsp",
	gopls: "gopls",
	"golang.org/x/tools/gopls": "gopls",
	"yaml-language-server": "yaml-language-server",
	"rust-analyzer": "rust-analyzer",
	dart: "dart",
	"dart-sdk": "dart",
};

function firstPackageFromCommand(cmd: string): string | null {
	// Matches `npm install -g <pkg>` or `pip install <pkg>` or `pipx install <pkg>` or `go install <pkg>`
	const m = cmd.match(/(?:npm install -g|pip(?:x)? install|brew install|go install)\s+([^\s@]+)/);
	return m ? m[1]! : null;
}

describe("lsp commandNames vs install instructions (issue #457)", () => {
	it("every install instruction's first package produces a binary listed in commandNames", () => {
		const mismatches: string[] = [];
		for (const inst of INSTALL_INSTRUCTIONS_INTERNAL) {
			// Find matching spec (by language + serverName, since the install table is keyed that way)
			const spec = LSP_SERVER_SPECS.find((s) => s.language === inst.language && s.serverName === inst.serverName);
			if (!spec) {
				// Install hint may target a package whose spec lives under a different
				// serverName (e.g. `pyright` is the package, `pyright-langserver` is the
				// serverName). In that case, match by language only and verify ANY
				// spec for that language has a matching binary.
				const langSpec = LSP_SERVER_SPECS.find((s) => s.language === inst.language);
				if (!langSpec) {
					mismatches.push(`No LSP spec found for language=${inst.language}, serverName=${inst.serverName}`);
					continue;
				}
				verifyCommand(inst, langSpec, mismatches);
				continue;
			}
			verifyCommand(inst, spec, mismatches);
		}
		expect(mismatches, mismatches.join("\n")).toEqual([]);
	});
});

function verifyCommand(
	inst: { language: string; serverName: string; commands: string[] },
	spec: { language: string; serverName: string; commandNames: readonly string[] },
	mismatches: string[],
): void {
	for (const cmd of inst.commands) {
		const pkg = firstPackageFromCommand(cmd);
		if (!pkg) continue; // skip non-package commands (e.g. rustup component, brew install)
		const expectedBinary = PACKAGE_TO_BINARY[pkg];
		if (!expectedBinary) {
			mismatches.push(`Unknown package in test allowlist: ${pkg} (command: ${cmd})`);
			continue;
		}
		if (!spec.commandNames.includes(expectedBinary)) {
			mismatches.push(
				`LSP spec for language=${spec.language}, serverName=${spec.serverName} ` +
					`does not list binary "${expectedBinary}" (installed by package "${pkg}"). ` +
					`commandNames=[${spec.commandNames.join(", ")}]`,
			);
		}
	}
}

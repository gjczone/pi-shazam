/**
 * pi-shazam lsp/servers — Language server configuration table.
 *
 * Ported from repomap/src/lsp.py (LSP_SPECS, language_for_file).
 * Only 6 languages: Python (pyright + pylsp), TypeScript, Go, JSON, YAML, Rust.
 */

// ── LSP server spec ──────────────────────────────────────────────────────────

export interface LspServerSpec {
	/** Language identifier (e.g., "python", "typescript") */
	language: string;
	/** Human-readable server name */
	serverName: string;
	/** Executable names to search for (first found wins) */
	commandNames: readonly string[];
	/** Default CLI arguments */
	args: readonly string[];
	/** File extensions this server handles */
	fileSuffixes: readonly string[];
	/** Root marker files (e.g., package.json, Cargo.toml) */
	rootMarkers: readonly string[];
	/** Relative paths from workspace root to check for project-local installs */
	projectRelativeCandidates?: readonly string[];
}

// ── Server specs ─────────────────────────────────────────────────────────────

export const LSP_SERVER_SPECS: readonly LspServerSpec[] = [
	// ── Python ──────────────────────────────────────────────────────────────
	{
		language: "python",
		serverName: "pyright-langserver",
		commandNames: ["pyright-langserver"] as const,
		args: ["--stdio"] as const,
		fileSuffixes: [".py", ".pyi", ".pyx", ".pxd"] as const,
		rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", ".venv"] as const,
		projectRelativeCandidates: [".venv/bin/pyright-langserver"] as const,
	},
	{
		language: "python",
		serverName: "pylsp",
		commandNames: ["pylsp"] as const,
		args: [] as const,
		fileSuffixes: [".py", ".pyi", ".pyx", ".pxd"] as const,
		rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", ".venv"] as const,
		projectRelativeCandidates: [".venv/bin/pylsp"] as const,
	},

	// ── TypeScript ──────────────────────────────────────────────────────────
	{
		language: "typescript",
		serverName: "typescript-language-server",
		commandNames: ["typescript-language-server"] as const,
		args: ["--stdio"] as const,
		fileSuffixes: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const,
		rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"] as const,
		projectRelativeCandidates: ["node_modules/.bin/typescript-language-server"] as const,
	},

	// ── Go ────────────────────────────────────────────────────────────────────
	{
		language: "go",
		serverName: "gopls",
		commandNames: ["gopls"] as const,
		args: [] as const,
		fileSuffixes: [".go"] as const,
		rootMarkers: ["go.mod", "go.work"] as const,
	},

	// ── YAML ──────────────────────────────────────────────────────────────────
	{
		language: "yaml",
		serverName: "yaml-language-server",
		commandNames: ["yaml-language-server"] as const,
		args: ["--stdio"] as const,
		fileSuffixes: [".yaml", ".yml"] as const,
		rootMarkers: [".github"] as const,
	},

	// ── JSON ──────────────────────────────────────────────────────────────────
	{
		language: "json",
		serverName: "vscode-json-languageserver",
		commandNames: ["vscode-json-languageserver"] as const,
		args: ["--stdio"] as const,
		fileSuffixes: [".json", ".jsonc", ".json5"] as const,
		rootMarkers: [".git", "package.json"] as const,
	},

	// ── Rust ──────────────────────────────────────────────────────────────────
	{
		language: "rust",
		serverName: "rust-analyzer",
		commandNames: ["rust-analyzer"] as const,
		args: [] as const,
		fileSuffixes: [".rs"] as const,
		rootMarkers: ["Cargo.toml"] as const,
	},

	// ── Dart (Flutter) ──────────────────────────────────────────────────────────────
	{
		language: "dart",
		serverName: "dart-language-server",
		commandNames: ["dart"] as const,
		args: ["language-server"] as const,
		fileSuffixes: [".dart"] as const,
		rootMarkers: ["pubspec.yaml", "analysis_options.yaml"] as const,
	},
];

// ── Suffix → language mapping ────────────────────────────────────────────────

/** File suffix → LSP language mapping, derived from LSP_SERVER_SPECS. */
export const suffixToLanguage: Record<string, string> = {};

for (const spec of LSP_SERVER_SPECS) {
	for (const suffix of spec.fileSuffixes) {
		if (!suffixToLanguage[suffix]) {
			suffixToLanguage[suffix] = spec.language;
		}
	}
}

// ── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Get the LSP language for a file based on its extension.
 */
export function languageForSuffix(suffix: string): string | undefined {
	return suffixToLanguage[suffix.toLowerCase()];
}

/**
 * Get all server specs for a given language.
 */
export function specsForLanguage(language: string): LspServerSpec[] {
	return LSP_SERVER_SPECS.filter((s) => s.language === language);
}

/**
 * Get all unique LSP languages from file suffixes.
 */
export function languagesForSuffixes(suffixes: string[]): string[] {
	const langs = new Set<string>();
	for (const suffix of suffixes) {
		const lang = languageForSuffix(suffix);
		if (lang) langs.add(lang);
	}
	return [...langs].sort();
}

// ── LSP timeouts by language ─────────────────────────────────────────────────

const LSP_TIMEOUT_BY_LANGUAGE: Record<string, number> = {
	typescript: 15_000,
	python: 12_000,
	rust: 20_000,
	go: 8_000,
	yaml: 8_000,
	json: 8_000,
	dart: 12_000,
};

export const DEFAULT_LSP_TIMEOUT_MS = 8_000;

/**
 * Get the recommended LSP timeout for a language (in milliseconds).
 */
export function lspTimeoutFor(language: string): number {
	return LSP_TIMEOUT_BY_LANGUAGE[language] ?? DEFAULT_LSP_TIMEOUT_MS;
}

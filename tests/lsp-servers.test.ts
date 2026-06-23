import { describe, it, expect } from "vitest";
import { LSP_SERVER_SPECS, suffixToLanguage, languageForSuffix } from "../lsp/servers.js";

describe("lsp/servers", () => {
	describe("LSP_SERVER_SPECS", () => {
		it("should contain exactly 7 language entries", () => {
			const languages = new Set(LSP_SERVER_SPECS.map((s) => s.language));
			// 7 languages: python, typescript, go, yaml, json, rust, dart
			// python has 2 specs (pyright + pylsp), so specs count >= 8
			expect(languages.size).toBe(7);
		});

		it("should have python specs (pyright + pylsp)", () => {
			const pythonSpecs = LSP_SERVER_SPECS.filter((s) => s.language === "python");
			expect(pythonSpecs.length).toBeGreaterThanOrEqual(2);
			const serverNames = pythonSpecs.map((s) => s.serverName);
			expect(serverNames).toContain("pyright-langserver");
			expect(serverNames).toContain("pylsp");
		});

		it("should have typescript spec", () => {
			const ts = LSP_SERVER_SPECS.find((s) => s.language === "typescript");
			expect(ts).toBeDefined();
			expect(ts!.serverName).toBe("typescript-language-server");
			expect(ts!.commandNames).toContain("typescript-language-server");
			expect(ts!.args).toContain("--stdio");
			expect(ts!.fileSuffixes).toContain(".ts");
			expect(ts!.fileSuffixes).toContain(".tsx");
			expect(ts!.fileSuffixes).toContain(".js");
			expect(ts!.fileSuffixes).toContain(".jsx");
			expect(ts!.fileSuffixes).toContain(".mjs");
			expect(ts!.fileSuffixes).toContain(".cjs");
			expect(ts!.fileSuffixes).toContain(".mts");
			expect(ts!.fileSuffixes).toContain(".cts");
		});

		it("should have go spec", () => {
			const go = LSP_SERVER_SPECS.find((s) => s.language === "go");
			expect(go).toBeDefined();
			expect(go!.serverName).toBe("gopls");
			expect(go!.commandNames).toContain("gopls");
			expect(go!.fileSuffixes).toContain(".go");
			expect(go!.rootMarkers).toContain("go.mod");
		});

		it("should have rust spec", () => {
			const rust = LSP_SERVER_SPECS.find((s) => s.language === "rust");
			expect(rust).toBeDefined();
			expect(rust!.serverName).toBe("rust-analyzer");
			expect(rust!.commandNames).toContain("rust-analyzer");
			expect(rust!.fileSuffixes).toContain(".rs");
			expect(rust!.rootMarkers).toContain("Cargo.toml");
		});

		it("should have yaml spec", () => {
			const yaml = LSP_SERVER_SPECS.find((s) => s.language === "yaml");
			expect(yaml).toBeDefined();
			expect(yaml!.fileSuffixes).toContain(".yaml");
			expect(yaml!.fileSuffixes).toContain(".yml");
		});

		it("should have dart spec", () => {
			const dart = LSP_SERVER_SPECS.find((s) => s.language === "dart");
			expect(dart).toBeDefined();
			expect(dart!.serverName).toBe("dart");
			expect(dart!.commandNames).toContain("dart");
			expect(dart!.args).toContain("language-server");
			expect(dart!.fileSuffixes).toContain(".dart");
			expect(dart!.rootMarkers).toContain("pubspec.yaml");
		});

		it("should NOT have specs for removed languages", () => {
			const removedLanguages = [
				"javascript",
				"c",
				"cpp",
				"java",
				"kotlin",
				"swift",
				"csharp",
				"php",
				"ruby",
				"html",
				"css",
			];
			for (const lang of removedLanguages) {
				const spec = LSP_SERVER_SPECS.find((s) => s.language === lang);
				expect(spec).toBeUndefined();
			}
		});

		it("every spec should have required fields", () => {
			for (const spec of LSP_SERVER_SPECS) {
				expect(spec.language).toBeTruthy();
				expect(spec.serverName).toBeTruthy();
				expect(spec.commandNames.length).toBeGreaterThan(0);
				expect(spec.fileSuffixes.length).toBeGreaterThan(0);
				expect(spec.rootMarkers.length).toBeGreaterThan(0);
			}
		});
	});

	describe("languageForSuffix", () => {
		it("should map known suffixes", () => {
			expect(languageForSuffix(".py")).toBe("python");
			expect(languageForSuffix(".ts")).toBe("typescript");
			expect(languageForSuffix(".tsx")).toBe("typescript");
			expect(languageForSuffix(".go")).toBe("go");
			expect(languageForSuffix(".rs")).toBe("rust");

			expect(languageForSuffix(".yaml")).toBe("yaml");
			expect(languageForSuffix(".yml")).toBe("yaml");
		});

		it("should return undefined for unknown suffixes", () => {
			expect(languageForSuffix(".cpp")).toBeUndefined();
			expect(languageForSuffix(".java")).toBeUndefined();
			expect(languageForSuffix(".rb")).toBeUndefined();
			expect(languageForSuffix(".xyz")).toBeUndefined();
		});
	});

	describe("suffixToLanguage", () => {
		it("should be derived from LSP_SERVER_SPECS", () => {
			expect(suffixToLanguage[".py"]).toBe("python");
			expect(suffixToLanguage[".ts"]).toBe("typescript");
			expect(suffixToLanguage[".rs"]).toBe("rust");
		});

		it("should NOT contain suffixes for removed languages", () => {
			// .js is now covered by TypeScript LSP -> expected to be present
			expect(suffixToLanguage[".c"]).toBeUndefined();
			expect(suffixToLanguage[".cpp"]).toBeUndefined();
			expect(suffixToLanguage[".java"]).toBeUndefined();
			expect(suffixToLanguage[".rb"]).toBeUndefined();
			expect(suffixToLanguage[".php"]).toBeUndefined();
			expect(suffixToLanguage[".swift"]).toBeUndefined();
			expect(suffixToLanguage[".cs"]).toBeUndefined();
			expect(suffixToLanguage[".html"]).toBeUndefined();
			expect(suffixToLanguage[".css"]).toBeUndefined();
		});
	});
});

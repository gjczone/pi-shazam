/**
 * pi-shazam core/treesitter -- Tree-sitter AST parsing + symbol extraction.
 *
 * Ported from repomap/src/parser.py (TreeSitterAdapter).
 *
 * Node.js tree-sitter (v0.22.4) API:
 * - Parser = require("tree-sitter") (default export is the Parser)
 * - Query = require("tree-sitter").Query (named export)
 * - parser.setLanguage(grammarModule) -- pass grammar module directly
 * - query.captures(node) -> {name: string, node: SyntaxNode}[]
 *
 * Grammar modules (tree-sitter-python etc.) export objects with
 * {name, language, nodeTypeInfo} -- they are passed directly to
 * setLanguage() and Query constructor.
 */

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const _tsModule = _require("tree-sitter");
const _ParserCtor = _tsModule.default ?? _tsModule;
if (typeof _ParserCtor !== "function") {
	throw new Error("tree-sitter: expected constructor function, got " + typeof _ParserCtor);
}
const Parser = _ParserCtor as new () => ParserInstance;
const _QueryCtor = _tsModule.Query;
if (typeof _QueryCtor !== "function") {
	throw new Error("tree-sitter: Query is not a constructor, got " + typeof _QueryCtor);
}
const Query = _QueryCtor as new (language: unknown, source: string) => QueryInstance;

import { createSymbol } from "./graph.js";
import type { Symbol, JSImportBinding } from "./graph.js";
import { QUERIES } from "./treesitter-queries.js";

// -- Runtime type stubs for tree-sitter (no @types available) -----------------

interface ParserInstance {
	setLanguage(language: unknown): void;
	getLanguage(): unknown;
	parse(input: string, oldTree?: Tree | null, options?: Record<string, unknown>): Tree;
}

interface Tree {
	rootNode: SyntaxNode;
	/** Release native memory; tree is unusable after calling. */
	delete?(): void;
}

interface SyntaxNode {
	type: string;
	text: string;
	children: SyntaxNode[];
	parent: SyntaxNode | null;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	childForFieldName?(name: string): SyntaxNode | null;
}

interface QueryInstance {
	captures(node: SyntaxNode, options?: Record<string, unknown>): { name: string; node: SyntaxNode }[];
}

// -- File extension -> tree-sitter language mapping ----------------------------

export const EXT_TO_LANG: Record<string, string> = {
	".py": "python",
	".pyi": "python",
	".ts": "typescript",
	".tsx": "tsx",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".go": "go",
	".rs": "rust",
	".dart": "dart",
	".json": "json",
};

// -- Parser availability tracking --------------------------------------------
// Module-level state tracking for each language's parser load result.
// Lets overview and before-start hook report unavailable languages to the LLM,
// avoiding "silent failures" where tools return empty results but the LLM doesn't know why.

export interface ParserStatusInfo {
	status: "loaded" | "unavailable";
	reason?: string;
	suggestion?: string;
}

const _parserStatus = new Map<string, ParserStatusInfo>();

/**
 * Get parser load status for all registered languages.
 * Overview and before-start hook use this to report language availability to the LLM.
 */
export function getParserStatus(): Map<string, ParserStatusInfo> {
	// Ensure all EXT_TO_LANG languages have a record (even if adapter was never constructed)
	for (const lang of Object.values(EXT_TO_LANG)) {
		if (!_parserStatus.has(lang)) {
			_parserStatus.set(lang, { status: "unavailable", reason: "Parser not yet initialized" });
		}
	}
	return new Map(_parserStatus);
}

/**
 * Return unavailable parser warnings only for languages actually used in the project.
 *
 * A pure TypeScript project won't see Dart warnings, and a Python + TS full-stack
 * project won't either -- only languages whose source files exist in the project
 * AND whose parser is unavailable will produce warnings.
 * This avoids noise from "indiscriminate broadcast".
 *
 * @param filePaths - List of relative file paths in the project (e.g., graph.fileSymbols.keys())
 * @returns Only languages that the project uses but whose parser is unavailable
 */
export function getProjectParserWarnings(filePaths: Iterable<string>): [string, ParserStatusInfo][] {
	// Detect which languages the project actually uses
	const projectLangs = new Set<string>();
	for (const filePath of filePaths) {
		const dotIdx = filePath.lastIndexOf(".");
		if (dotIdx < 0) continue;
		const ext = filePath.slice(dotIdx).toLowerCase();
		const lang = EXT_TO_LANG[ext];
		if (lang) projectLangs.add(lang);
	}

	// Only return languages that the project uses AND whose parser is unavailable
	const status = getParserStatus();
	const warnings: [string, ParserStatusInfo][] = [];
	for (const lang of projectLangs) {
		const info = status.get(lang);
		if (info && info.status === "unavailable") {
			warnings.push([lang, info]);
		}
	}
	return warnings;
}

export class TreeSitterAdapter {
	private parsers = new Map<string, ParserInstance>();
	private queries = new Map<string, Map<string, QueryInstance>>();
	private log: (msg: string) => void;

	constructor(log?: (msg: string) => void) {
		this.log = log ?? (() => {});
		this._initParsers();
	}

	// -- Initialization ---------------------------------------------------------

	private _initParsers(): void {
		const grammars: [string, string, string?][] = [
			["python", "tree-sitter-python", "python"],
			["javascript", "tree-sitter-javascript"],
			["go", "tree-sitter-go", "go"],
			["rust", "tree-sitter-rust", "rust"],
			["dart", "@sengac/tree-sitter-dart"],
			["json", "tree-sitter-json", "json"],
		];

		for (const [lang, _pkg, _prop] of grammars) {
			this._loadGrammar(lang, _pkg);
		}

		// TypeScript + TSX -- special handling
		this._loadTypeScript();

		// Precompile queries
		this._precompileQueries();
	}

	private _loadGrammar(lang: string, pkg: string): void {
		try {
			const grammar = _require(pkg);
			const parser = new Parser();
			parser.setLanguage(grammar);
			this.parsers.set(lang, parser);
			_parserStatus.set(lang, { status: "loaded" });
			this.log(`Parser loaded: ${lang}`);
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			const suggestion =
				lang === "dart"
					? "LSP support still works (hover, verify, fix). Tree-sitter parsing for Dart requires tree-sitter >=0.24; current version is 0.22.x."
					: "LSP support still works (hover, verify, fix). Tree-sitter parsing unavailable.";
			_parserStatus.set(lang, {
				status: "unavailable",
				reason,
				suggestion,
			});
			this.log(`Parser unavailable [${lang}]: ${e}`);
		}
	}

	private _loadTypeScript(): void {
		try {
			const tsMod = _require("tree-sitter-typescript");
			const tsGrammar = tsMod.typescript ?? tsMod;

			const tsParser = new Parser();
			tsParser.setLanguage(tsGrammar);
			this.parsers.set("typescript", tsParser);
			_parserStatus.set("typescript", { status: "loaded" });
			this.log("Parser loaded: typescript (dedicated)");

			try {
				const tsxGrammar = tsMod.tsx ?? tsMod;
				const tsxParser = new Parser();
				tsxParser.setLanguage(tsxGrammar);
				this.parsers.set("tsx", tsxParser);
				_parserStatus.set("tsx", { status: "loaded" });
				this.log("Parser loaded: tsx (dedicated)");
			} catch (err) {
				_parserStatus.set("tsx", {
					status: "unavailable",
					reason: "TSX grammar load failed",
					suggestion: "Falls back to TypeScript parser.",
				});
				this.log(`TSX parser unavailable: ${err}`);
			}
		} catch (err) {
			// Fall back to JavaScript parser for TypeScript.
			// Create independent Parser instances for typescript and tsx fallbacks
			// instead of sharing the JavaScript parser reference -- the Parser holds
			// WASM state and concurrent parse() calls on the same instance corrupt it.
			const jsParser = this.parsers.get("javascript");
			if (jsParser) {
				const jsLang = jsParser.getLanguage();
				const tsFallback = new Parser();
				tsFallback.setLanguage(jsLang);
				const tsxFallback = new Parser();
				tsxFallback.setLanguage(jsLang);
				this.parsers.set("typescript", tsFallback);
				this.parsers.set("tsx", tsxFallback);
				_parserStatus.set("typescript", { status: "loaded", reason: "Fell back to JavaScript parser" });
				_parserStatus.set("tsx", { status: "loaded", reason: "Fell back to JavaScript parser" });
				this.log(`TypeScript parser unavailable, falling back to JavaScript parser: ${err}`);
			} else {
				_parserStatus.set("typescript", {
					status: "unavailable",
					reason: "TypeScript and JavaScript parsers both failed",
				});
				_parserStatus.set("tsx", { status: "unavailable", reason: "TypeScript and JavaScript parsers both failed" });
			}
		}
	}

	private _precompileQueries(): void {
		for (const [lang, patterns] of Object.entries(QUERIES)) {
			const parser = this.parsers.get(lang);
			if (!parser) continue;

			const langQueries = new Map<string, QueryInstance>();
			try {
				for (const [qtype, src] of Object.entries(patterns)) {
					if (!src || src.trim().length === 0) continue;
					try {
						// Query(language, source) -- language from parser
						const language = parser.getLanguage();
						const q = new Query(language, src);
						langQueries.set(qtype, q);
					} catch (e) {
						this.log(`Query compile failed [${lang}/${qtype}]: ${e}`);
					}
				}
			} catch (err) {
				this.log(`Unable to create queries for ${lang}: ${err}`);
			}
			this.queries.set(lang, langQueries);
		}
	}

	// -- Public API -------------------------------------------------------------

	hasLanguage(lang: string): boolean {
		return this.parsers.has(lang);
	}

	static langForExtension(ext: string): string | undefined {
		return EXT_TO_LANG[ext];
	}

	parse(source: string, lang: string): Tree | null {
		const parser = this.parsers.get(lang);
		if (!parser) return null;

		const MAX_PARSE_SIZE = 5 * 1024 * 1024; // 5MB - catches minified bundles/data files (fixes #101)
		const sourceBytes = Buffer.byteLength(source, "utf-8");
		if (sourceBytes > MAX_PARSE_SIZE) {
			this.log(`File too large for parsing (${sourceBytes} bytes > ${MAX_PARSE_SIZE}), skipping`);
			return null;
		}

		// Quick nesting depth check on first 256KB
		const scanStr = source.slice(0, 256 * 1024);
		const openCount =
			(scanStr.match(/\(/g) || []).length + (scanStr.match(/\{/g) || []).length + (scanStr.match(/\[/g) || []).length;
		const closeCount =
			(scanStr.match(/\)/g) || []).length + (scanStr.match(/\}/g) || []).length + (scanStr.match(/\]/g) || []).length;
		if (Math.abs(openCount - closeCount) > 100 || Math.max(openCount, closeCount) > 10_000) {
			this.log(`Extreme nesting risk detected (${openCount} open, ${closeCount} close), skipping`);
			return null;
		}

		try {
			return parser.parse(source);
		} catch (e) {
			this.log(`Parse error [${lang}]: ${e}`);
			return null;
		}
	}

	extractSymbols(tree: Tree, lang: string, file: string): Symbol[] {
		if (lang === "json") return this._extractJsonSymbols(tree, file);
		return this._extractStandardSymbols(tree, lang, file);
	}

	// -- Standard symbol extraction (function/class via query) ------------------

	private _extractStandardSymbols(tree: Tree, lang: string, file: string): Symbol[] {
		const symbolsById = new Map<string, Symbol>();
		const root = tree.rootNode;
		const langQueries = this.queries.get(lang);
		if (!langQueries) return [];

		for (const qtype of ["function", "class"]) {
			const query = langQueries.get(qtype);
			if (!query) continue;

			const captures = query.captures(root);
			const nameNodes: SyntaxNode[] = [];
			const defNodes: [SyntaxNode, string][] = [];

			for (const { name: capName, node } of captures) {
				if (capName === "name") {
					nameNodes.push(node);
				} else if (capName.includes("definition") || capName.includes("export")) {
					defNodes.push([node, capName]);
				}
			}

			// L3: Named constant for max name/def nodes to process per file
			const MAX_NAME_NODES = 5000;
			const MAX_MATCHING_DEFS = 5000;

			let namesProcessed = 0;
			for (const nameNode of nameNodes) {
				if (namesProcessed >= MAX_NAME_NODES) break;
				namesProcessed++;

				const matchingDefs: [SyntaxNode, string][] = [];
				for (const [defNode, defCap] of defNodes) {
					if (this._within(nameNode, defNode)) {
						matchingDefs.push([defNode, defCap]);
						if (matchingDefs.length >= MAX_MATCHING_DEFS) break;
					}
				}

				matchingDefs.sort((a, b) => {
					const aSize =
						(a[0].endPosition.row - a[0].startPosition.row) * 10000 +
						(a[0].endPosition.column - a[0].startPosition.column);
					const bSize =
						(b[0].endPosition.row - b[0].startPosition.row) * 10000 +
						(b[0].endPosition.column - b[0].startPosition.column);
					return (
						aSize - bSize ||
						a[0].startPosition.row - b[0].startPosition.row ||
						a[0].startPosition.column - b[0].startPosition.column
					);
				});

				for (const [defNode, defCap] of matchingDefs) {
					// Skip local variable declarations inside function bodies (not file-level).
					// For example, `const graph = createRepoGraph()` inside `scanFull()`,
					// where `createRepoGraph` matches the `create*` pattern,
					// but `graph` is a local variable and should not be extracted as a project-level symbol.
					if (this._isInsideFunction(defNode)) break;

					const kind = defCap.includes(".") ? defCap.split(".").pop()! : defCap;
					let vis: Symbol["visibility"] = this._isExported(defNode) ? "exported" : "public";
					const name = nameNode.text;
					if (!name) break;

					if (lang === "python" && name.startsWith("_") && !name.startsWith("__")) {
						vis = "private";
					}

					const symId = `${file}::${name}::${nameNode.startPosition.row + 1}`;
					const sym = createSymbol(symId, name, kind, file, nameNode.startPosition.row + 1, {
						endLine: defNode.endPosition.row + 1,
						col: nameNode.startPosition.column,
						visibility: vis,
						signature: this._signature(defNode),
					});
					symbolsById.set(symId, sym);
					break;
				}
			}
		}

		return [...symbolsById.values()].sort((a, b) => {
			return (
				a.file.localeCompare(b.file) ||
				a.line - b.line ||
				a.endLine - b.endLine ||
				a.col - b.col ||
				a.name.localeCompare(b.name) ||
				a.kind.localeCompare(b.kind)
			);
		});
	}

	// -- JSON symbol extraction ---------------------------------------------------

	private _extractJsonSymbols(tree: Tree, file: string): Symbol[] {
		const symbolsById = new Map<string, Symbol>();
		const seen = new Map<string, number>();

		for (const node of this._walkTree(tree.rootNode)) {
			if (node.type !== "pair") continue;
			const keyNode = node.childForFieldName?.("key");
			if (!keyNode) continue;
			const keyName = keyNode.text.replace(/^['"]|['"]$/g, "");
			if (!keyName) continue;

			const line = node.startPosition.row + 1;
			const key = `${keyName}:${line}`;
			const count = (seen.get(key) || 0) + 1;
			seen.set(key, count);
			const visibleName = count > 1 ? `${keyName}#${count}` : keyName;

			const symId = `${file}::${visibleName}::${line}`;
			symbolsById.set(
				symId,
				createSymbol(symId, visibleName, "json_key", file, line, {
					endLine: node.endPosition.row + 1,
					col: node.startPosition.column,
					visibility: "public",
					signature: `"${keyName}"`,
				}),
			);
		}

		return [...symbolsById.values()].sort(
			(a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || a.name.localeCompare(b.name),
		);
	}

	// -- Import extraction ------------------------------------------------------

	extractImports(tree: Tree, lang: string): [string, number][] {
		const langQueries = this.queries.get(lang);
		const query = langQueries?.get("import");
		if (!query) return [];

		const results = new Map<string, number>();
		const captures = query.captures(tree.rootNode);

		for (const { name: capName, node } of captures) {
			const isJs = ["javascript", "typescript", "tsx"].includes(lang);
			if (isJs && capName !== "source") continue;

			const text = node.text.replace(/^['"]|['"]$/g, "");
			if (!text) continue;

			const line = node.startPosition.row + 1;
			const key = `${text}::${line}`;
			if (!results.has(key)) {
				results.set(key, line);
			}
		}

		return [...results.entries()]
			.map(([k, line]) => {
				const idx = k.lastIndexOf("::");
				return [k.slice(0, idx), line] as [string, number];
			})
			.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
	}

	// -- Call extraction --------------------------------------------------------

	extractCalls(tree: Tree, lang: string): [string, number, string][] {
		const langQueries = this.queries.get(lang);
		const query = langQueries?.get("call");
		if (!query) return [];

		const results = new Set<string>();

		for (const { name: capName, node } of query.captures(tree.rootNode)) {
			if (capName !== "name") continue;
			const name = node.text;
			if (!name) continue;

			const kind = this._callRefKind(node);
			const line = node.startPosition.row + 1;
			results.add(`${name}::${line}::${kind}`);
		}

		return [...results]
			.map((s) => {
				const parts = s.split("::");
				return [parts[0]!, parseInt(parts[1]!, 10), parts[2]!] as [string, number, string];
			})
			.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]) || a[2].localeCompare(b[2]));
	}

	// -- Reference extraction --------------------------------------------------

	/**
	 * Extract identifier references from function call argument positions and return statements.
	 *
	 * Used to discover same-file callback/event handler references
	 * (e.g., `arr.map(edgeIdentity)` or `process.on("SIGTERM", onSignal)`),
	 * which do not appear in call extraction results (because the callee is not being called),
	 * but are valid symbol usages that should not be classified as orphans.
	 */
	extractRefs(tree: Tree, lang: string): [string, number][] {
		const langQueries = this.queries.get(lang);
		const query = langQueries?.get("ref");
		if (!query) return [];

		const results = new Map<string, number>();

		for (const { name: capName, node } of query.captures(tree.rootNode)) {
			if (capName !== "name") continue;
			const name = node.text;
			if (!name) continue;

			const line = node.startPosition.row + 1;
			const key = `${name}::${line}`;
			if (!results.has(key)) {
				results.set(key, line);
			}
		}

		return [...results.entries()]
			.map(([k, line]) => {
				const idx = k.lastIndexOf("::");
				return [k.slice(0, idx), line] as [string, number];
			})
			.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
	}

	// -- Type reference extraction (TypeScript/TSX) -----------------------------

	/**
	 * Extract type identifier references from type annotations, extends/implements clauses,
	 * generic type arguments, and return types.
	 *
	 * These references build type dependency edges in the graph, ensuring that
	 * interfaces/types used by other symbols receive appropriate PageRank scores
	 * instead of all having identical scores (issue #542).
	 */
	extractTypeRefs(tree: Tree, lang: string): [string, number][] {
		const langQueries = this.queries.get(lang);
		const query = langQueries?.get("type");
		if (!query) return [];

		const results = new Map<string, number>();

		for (const { name: capName, node } of query.captures(tree.rootNode)) {
			if (capName !== "name") continue;
			const name = node.text;
			if (!name) continue;

			// Skip predefined TypeScript types that are not user-defined symbols
			if (this._isPredefinedType(name)) continue;

			const line = node.startPosition.row + 1;
			const key = `${name}::${line}`;
			if (!results.has(key)) {
				results.set(key, line);
			}
		}

		return [...results.entries()]
			.map(([k, line]) => {
				const idx = k.lastIndexOf("::");
				return [k.slice(0, idx), line] as [string, number];
			})
			.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
	}

	/**
	 * Check if a type name is a TypeScript predefined/built-in type that should
	 * not be treated as a reference to a user-defined symbol.
	 */
	private _isPredefinedType(name: string): boolean {
		const PREDEFINED_TYPES = new Set([
			"string",
			"number",
			"boolean",
			"any",
			"unknown",
			"never",
			"void",
			"object",
			"symbol",
			"bigint",
			"undefined",
			"null",
			// Uppercase built-in constructors (used as types)
			"String",
			"Number",
			"Boolean",
			"Object",
			"Symbol",
			"BigInt",
			"Array",
			"Promise",
			"ReadonlyArray",
			"Partial",
			"Required",
			"Readonly",
			"Record",
			"Pick",
			"Omit",
			"Exclude",
			"Extract",
			"NonNullable",
			"Parameters",
			"ConstructorParameters",
			"ReturnType",
			"InstanceType",
			"Uppercase",
			"Lowercase",
			"Capitalize",
			"Uncapitalize",
		]);
		return PREDEFINED_TYPES.has(name);
	}

	// -- JS/TS import/export binding extraction ---------------------------------

	extractJsTsImportBindings(tree: Tree, lang: string): JSImportBinding[] {
		if (!["javascript", "typescript", "tsx"].includes(lang)) return [];

		const bindings = new Map<string, JSImportBinding>();

		for (const node of tree.rootNode.children) {
			if (node.type !== "import_statement") continue;

			const module = this._moduleLiteral(node);
			if (!module) continue;

			const line = node.startPosition.row + 1;
			const clause = this._firstChildOfType(node, "import_clause");
			if (!clause) continue;

			for (const child of clause.children) {
				if (child.type === "identifier") {
					const key = `d:${child.text}:${module}:${line}`;
					bindings.set(key, {
						localName: child.text,
						importedName: "default",
						module,
						line,
						kind: "default",
					});
				} else if (child.type === "named_imports") {
					for (const spec of child.children) {
						if (spec.type !== "import_specifier") continue;
						const src = this._idText(spec.childForFieldName?.("name")) || "";
						const alias = this._idText(spec.childForFieldName?.("alias")) || src;
						if (src && alias) {
							const key = `n:${alias}:${src}:${module}:${line}`;
							bindings.set(key, {
								localName: alias,
								importedName: src,
								module,
								line,
								kind: "named",
							});
						}
					}
				} else if (child.type === "namespace_import") {
					const name = this._lastIdent(child);
					if (name) {
						const key = `ns:${name}:*:${module}:${line}`;
						bindings.set(key, {
							localName: name,
							importedName: "*",
							module,
							line,
							kind: "namespace",
						});
					}
				}
			}
		}

		return [...bindings.values()].sort(
			(a, b) =>
				a.line - b.line ||
				a.module.localeCompare(b.module) ||
				a.localName.localeCompare(b.localName) ||
				a.importedName.localeCompare(b.importedName) ||
				a.kind.localeCompare(b.kind),
		);
	}

	// -- AST helpers ------------------------------------------------------------

	private _walkTree(root: SyntaxNode, maxNodes = 500_000): SyntaxNode[] {
		const nodes = [root];
		const result: SyntaxNode[] = [];
		while (nodes.length > 0 && result.length < maxNodes) {
			const cur = nodes.pop()!;
			result.push(cur);
			for (let i = cur.children.length - 1; i >= 0; i--) {
				nodes.push(cur.children[i]!);
			}
		}
		return result;
	}

	private _firstChildOfType(node: SyntaxNode, nodeType: string): SyntaxNode | null {
		for (const child of node.children) {
			if (child.type === nodeType) return child;
		}
		return null;
	}

	private _isExported(node: SyntaxNode): boolean {
		// Check the immediate node for Rust-style visibility_modifier (pub, pub(crate), etc.).
		// In Rust grammar, visibility_modifier is a direct child of the item node
		// (function_item, struct_item, etc.), not an ancestor wrapper.
		// We only check the immediate node's children to avoid false positives from
		// nested items (e.g., a pub field inside a private struct).
		for (const child of node.children) {
			if (child.type === "visibility_modifier" && child.text.startsWith("pub")) {
				return true;
			}
		}

		// Walk up parent chain for JS/TS-style export wrappers
		// (export_statement, export_declaration, etc.)
		let ancestor: SyntaxNode | null = node.parent;
		while (ancestor) {
			if (ancestor.type.includes("export")) {
				return true;
			}
			ancestor = ancestor.parent;
		}
		return false;
	}

	private _within(inner: SyntaxNode, outer: SyntaxNode): boolean {
		// Compare positions as (row, column) pairs with proper lexicographic ordering.
		// A position (r1, c1) is <= (r2, c2) iff r1 < r2 or (r1 === r2 and c1 <= c2).
		// Use >= and <= (not strict > and <) so that a name node starting at
		// exactly the same position as the definition node is considered "within"
		// (common where the identifier is the first child of the definition).
		const startOk =
			inner.startPosition.row > outer.startPosition.row ||
			(inner.startPosition.row === outer.startPosition.row && inner.startPosition.column >= outer.startPosition.column);
		const endOk =
			inner.endPosition.row < outer.endPosition.row ||
			(inner.endPosition.row === outer.endPosition.row && inner.endPosition.column <= outer.endPosition.column);
		return startOk && endOk;
	}

	// Check whether any ancestor of the node is a function/method/arrow function,
	// used to exclude local variable declarations inside function bodies (not file-level symbols).
	private _isInsideFunction(node: SyntaxNode): boolean {
		const FUNCTION_TYPES = new Set([
			"function_declaration",
			"function_definition",
			"function_item",
			"function_expression",
			"arrow_function",
			"method_definition",
			"method_declaration",
			"function_signature",
			"method_signature",
			"constructor_signature",
			"constructor_declaration",
			"local_function_statement",
			"method",
			"function_signature_item",
		]);
		let ancestor: SyntaxNode | null = node.parent;
		while (ancestor) {
			if (FUNCTION_TYPES.has(ancestor.type)) return true;
			ancestor = ancestor.parent;
		}
		return false;
	}

	private _callRefKind(node: SyntaxNode): string {
		let parent = node.parent;
		while (parent) {
			if (parent.type === "call_expression" || parent.type === "call") {
				const fn = parent.childForFieldName?.("function");
				if (fn && ["member_expression", "field_expression", "selector_expression", "attribute"].includes(fn.type)) {
					return "member";
				}
				return "direct";
			}
			parent = parent.parent;
		}
		return "direct";
	}

	// -- Text helpers -----------------------------------------------------------

	private _moduleLiteral(node: SyntaxNode): string | null {
		for (const child of node.children) {
			if (child.type === "string" || child.type === "string_fragment") {
				return child.text.replace(/^['"`]|['"`]$/g, "");
			}
		}
		return null;
	}

	private _idText(node: SyntaxNode | null | undefined): string | null {
		if (!node) return null;
		if (["identifier", "property_identifier", "type_identifier", "shorthand_property_identifier"].includes(node.type)) {
			return node.text;
		}
		return null;
	}

	private _lastIdent(node: SyntaxNode): string | null {
		const ids = node.children
			.filter((c) => ["identifier", "property_identifier", "type_identifier"].includes(c.type))
			.map((c) => c.text);
		return ids.length > 0 ? ids[ids.length - 1]! : null;
	}

	private _signature(node: SyntaxNode): string {
		const text = node.text;
		const firstLine = text.split("\n")[0] || "";
		return firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
	}
}

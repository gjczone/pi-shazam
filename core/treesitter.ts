/**
 * pi-shazam core/treesitter — Tree-sitter AST parsing + symbol extraction.
 *
 * Ported from repomap/src/parser.py (TreeSitterAdapter).
 *
 * Node.js tree-sitter (v0.22.4) API:
 * - Parser = require("tree-sitter") (default export is the Parser)
 * - Query = require("tree-sitter").Query (named export)
 * - parser.setLanguage(grammarModule) — pass grammar module directly
 * - query.captures(node) → {name: string, node: SyntaxNode}[]
 *
 * Grammar modules (tree-sitter-python etc.) export objects with
 * {name, language, nodeTypeInfo} — they are passed directly to
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

// ── Runtime type stubs for tree-sitter (no @types available) ─────────────────

interface ParserInstance {
	setLanguage(language: unknown): void;
	getLanguage(): unknown;
	parse(input: string, oldTree?: Tree | null, options?: Record<string, unknown>): Tree;
}

interface Tree {
	rootNode: SyntaxNode;
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

// ── File extension → tree-sitter language mapping ────────────────────────────

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

// ── Parser availability tracking ────────────────────────────────────────────
// 模块级状态记录，追踪每个语言的 parser 加载结果。
// 让 overview 和 before-start hook 能向 LLM 报告哪些语言不可用，
// 避免"静默失败"——工具返回空结果但 LLM 不知道原因。

export interface ParserStatusInfo {
	status: "loaded" | "unavailable";
	reason?: string;
	suggestion?: string;
}

const _parserStatus = new Map<string, ParserStatusInfo>();

/**
 * 获取所有注册语言的 parser 加载状态。
 * overview 和 before-start hook 用此函数向 LLM 报告语言可用性。
 */
export function getParserStatus(): Map<string, ParserStatusInfo> {
	// 确保所有 EXT_TO_LANG 语言都有记录（即使 adapter 未构造）
	for (const lang of Object.values(EXT_TO_LANG)) {
		if (!_parserStatus.has(lang)) {
			_parserStatus.set(lang, { status: "unavailable", reason: "Parser not yet initialized" });
		}
	}
	return new Map(_parserStatus);
}

export class TreeSitterAdapter {
	private parsers = new Map<string, ParserInstance>();
	private queries = new Map<string, Map<string, QueryInstance>>();
	private log: (msg: string) => void;

	constructor(log?: (msg: string) => void) {
		this.log = log ?? (() => {});
		this._initParsers();
	}

	// ── Initialization ─────────────────────────────────────────────────────────

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

		// TypeScript + TSX — special handling
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
			_parserStatus.set(lang, {
				status: "unavailable",
				reason,
				suggestion: `LSP support still works (hover, verify, fix). Tree-sitter parsing unavailable — upgrade tree-sitter to enable.`,
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
			} catch {
				_parserStatus.set("tsx", { status: "unavailable", reason: "TSX grammar load failed", suggestion: "Falls back to TypeScript parser." });
				this.log("TSX parser unavailable");
			}
		} catch {
			// Fall back to JavaScript parser for TypeScript
			const jsParser = this.parsers.get("javascript");
			if (jsParser) {
				this.parsers.set("typescript", jsParser);
				_parserStatus.set("typescript", { status: "loaded", reason: "Fell back to JavaScript parser" });
				_parserStatus.set("tsx", { status: "loaded", reason: "Fell back to JavaScript parser" });
				this.log("TypeScript parser unavailable, falling back to JavaScript parser");
			} else {
				_parserStatus.set("typescript", { status: "unavailable", reason: "TypeScript and JavaScript parsers both failed" });
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
						// Query(language, source) — language from parser
						const language = parser.getLanguage();
						const q = new Query(language, src);
						langQueries.set(qtype, q);
					} catch (e) {
						this.log(`Query compile failed [${lang}/${qtype}]: ${e}`);
					}
				}
			} catch {
				this.log(`Unable to create queries for ${lang}`);
			}
			this.queries.set(lang, langQueries);
		}
	}

	// ── Public API ─────────────────────────────────────────────────────────────

	hasLanguage(lang: string): boolean {
		return this.parsers.has(lang);
	}

	static langForExtension(ext: string): string | undefined {
		return EXT_TO_LANG[ext];
	}

	parse(source: string, lang: string): Tree | null {
		const parser = this.parsers.get(lang);
		if (!parser) return null;

		const MAX_PARSE_SIZE = 5 * 1024 * 1024; // 5MB — catches minified bundles/data files (fixes #101)
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

	// ── Standard symbol extraction (function/class via query) ──────────────────

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

			let namesProcessed = 0;
			for (const nameNode of nameNodes) {
				if (namesProcessed >= 5000) break;
				namesProcessed++;

				const matchingDefs: [SyntaxNode, string][] = [];
				for (const [defNode, defCap] of defNodes) {
					if (this._within(nameNode, defNode)) {
						matchingDefs.push([defNode, defCap]);
						if (matchingDefs.length >= 5000) break;
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

	// ── JSON symbol extraction ───────────────────────────────────────────────────

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

	// ── Import extraction ──────────────────────────────────────────────────────

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

	// ── Call extraction ────────────────────────────────────────────────────────

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

	// ── JS/TS import/export binding extraction ─────────────────────────────────

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

	// ── AST helpers ────────────────────────────────────────────────────────────

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
		// Walk up the parent chain looking for an export node
		// (e.g., export_statement in tree-sitter-typescript/tree-sitter-javascript)
		let ancestor: SyntaxNode | null = node;
		while (ancestor) {
			if (ancestor.type.includes("export")) {
				return true;
			}
			// Rust: check for visibility_modifier (pub, pub(crate), pub(super), etc.)
			// The visibility_modifier is a sibling/child of the definition node in
			// Rust's tree-sitter grammar, not an ancestor wrapper.
			for (const child of ancestor.children) {
				if (child.type === "visibility_modifier" && child.text.startsWith("pub")) {
					return true;
				}
			}
			ancestor = ancestor.parent;
		}
		return false;
	}

	private _within(inner: SyntaxNode, outer: SyntaxNode): boolean {
		// Compare positions as (row, column) pairs with proper lexicographic ordering.
		// A position (r1, c1) is <= (r2, c2) iff r1 < r2 or (r1 === r2 and c1 <= c2).
		const startOk =
			inner.startPosition.row > outer.startPosition.row ||
			(inner.startPosition.row === outer.startPosition.row && inner.startPosition.column >= outer.startPosition.column);
		const endOk =
			inner.endPosition.row < outer.endPosition.row ||
			(inner.endPosition.row === outer.endPosition.row && inner.endPosition.column <= outer.endPosition.column);
		return startOk && endOk;
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

	// ── Text helpers ───────────────────────────────────────────────────────────

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

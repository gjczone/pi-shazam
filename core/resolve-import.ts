/**
 * pi-shazam core/resolve-import -- Shared import path resolution.
 *
 * Single source of truth for resolving import specifiers to file paths.
 * Consolidates the full multi-language resolution (from scanner.ts) and
 * the simple JS/TS resolution (from filter.ts) into one module,
 * eliminating the diverged duplicate (issue #571 step 8).
 *
 * Supports JS/TS extensionless imports, Python dotted modules,
 * Rust mod/crate/super paths, Go relative imports, and Dart
 * package/relative imports.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RepoGraph } from "./graph.js";

// -- Disk existence cache ------------------------------------------------------

/**
 * Cache for existsSync results to avoid repeated syscalls during import resolution.
 * Keyed by absolute path; cleared when scanProject starts fresh.
 */
let _existsCache: Map<string, boolean> | null = null;

/**
 * Check if a path exists, using a per-scan cache to avoid redundant syscalls.
 */
export function existsCached(absPath: string): boolean {
	if (!_existsCache) {
		_existsCache = new Map();
	}
	const cached = _existsCache.get(absPath);
	if (cached !== undefined) return cached;
	const result = existsSync(absPath);
	_existsCache.set(absPath, result);
	return result;
}

/**
 * Clear the existsSync cache. Called at the start of each scanProject
 * to ensure fresh results after filesystem changes.
 */
export function clearExistsCache(): void {
	_existsCache = null;
}

// -- Full import resolution (from scanner.ts) -----------------------------------

/**
 * Check if any candidate path exists, using graph lookup first then cached disk check.
 */
export function tryCandidate(graph: RepoGraph | undefined, root: string, relCandidate: string): string | null {
	if (graph && graph.fileSymbols.has(relCandidate)) return relCandidate;
	if (existsCached(join(root, relCandidate))) return relCandidate;
	return null;
}

/**
 * Resolve a relative or language-specific import path to a file path that matches fileSymbols keys.
 * Handles JS/TS extensionless imports, Python dotted modules, Rust mod declarations,
 * Go relative imports, and Dart package/relative imports.
 *
 * This is the full multi-language resolver. For the simpler JS/TS-only
 * resolution used by filter.ts findOrphans, see resolveModulePath + moduleMatchesFile.
 */
export function resolveImport(importPath: string, fromFile: string, root: string, graph?: RepoGraph): string | null {
	const fromDir = dirname(fromFile);
	const fromExt = fromFile.slice(fromFile.lastIndexOf(".")).toLowerCase();
	const absRoot = resolve(root);

	// Dart: package: imports map to lib/ directory (standard Dart layout)
	if (importPath.startsWith("package:")) {
		const pkgPath = importPath.slice("package:".length);
		const slashIdx = pkgPath.indexOf("/");
		if (slashIdx > 0) {
			const libRel = `lib/${pkgPath.slice(slashIdx + 1)}`;
			const candidates = [libRel, `${libRel}.dart`];
			for (const c of candidates) {
				const found = tryCandidate(graph, root, c);
				if (found) return found;
			}
		}
		return importPath;
	}

	// Relative imports (./ or ../) - cross-language handling
	if (importPath.startsWith(".")) {
		const resolved = join(fromDir, importPath);

		// JS/TS candidates
		if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(fromExt) || fromExt === "") {
			const jsCandidates = [
				resolved,
				`${resolved}.ts`,
				`${resolved}.tsx`,
				`${resolved}.js`,
				`${resolved}.jsx`,
				`${resolved}.mjs`,
				`${resolved}.cjs`,
				`${resolved}.mts`,
				`${resolved}.cts`,
				`${resolved}/index.ts`,
				`${resolved}/index.tsx`,
				`${resolved}/index.js`,
			];
			for (const c of jsCandidates) {
				const found = tryCandidate(graph, root, c);
				if (found) return found;
			}
			return null;
		}

		// Python relative import: from .foo import bar or from .. import baz
		if (fromExt === ".py") {
			const pyCandidates = [`${resolved}.py`, join(resolved, "__init__.py")];
			for (const c of pyCandidates) {
				const found = tryCandidate(graph, root, c);
				if (found) return found;
			}
			return null;
		}

		// Rust relative mod/use: typically resolved through module system,
		// but `super::` paths are parent-relative. Try direct file match.
		if (fromExt === ".rs") {
			const rsCandidates = [`${resolved}.rs`, join(resolved, "mod.rs")];
			for (const c of rsCandidates) {
				const found = tryCandidate(graph, root, c);
				if (found) return found;
			}
			return null;
		}

		// Go relative imports
		if (fromExt === ".go") {
			const goFile = `${resolved}.go`;
			const found = tryCandidate(graph, root, goFile);
			if (found) return found;
			// Directory-based package (look for .go files in dir)
			if (existsCached(join(absRoot, resolved))) {
				return resolved;
			}
			return null;
		}

		// Dart relative imports
		if (fromExt === ".dart") {
			const dartCandidates = [resolved, `${resolved}.dart`];
			for (const c of dartCandidates) {
				const found = tryCandidate(graph, root, c);
				if (found) return found;
			}
			return null;
		}

		return null;
	}

	// Python dotted import: foo.bar.baz -> foo/bar/baz.py or foo/bar/baz/__init__.py
	if (fromExt === ".py" && /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(importPath)) {
		const relPath = importPath.replace(/\./g, "/");
		// Check if we're in a src/ layout by looking for src/ or the import from project root
		const pyCandidates = [
			`${relPath}.py`,
			join(relPath, "__init__.py"),
			join("src", `${relPath}.py`),
			join("src", relPath, "__init__.py"),
		];
		for (const c of pyCandidates) {
			const found = tryCandidate(graph, root, c);
			if (found) return found;
		}
		return null;
	}

	// Rust mod X; -> X.rs or X/mod.rs (sibling to current file's directory)
	// Rust crate:: paths: crate::foo::bar -> src/foo/bar.rs relative to crate root
	if (fromExt === ".rs") {
		if (importPath.startsWith("crate::")) {
			// Find crate root (directory containing Cargo.toml) by walking up
			const cratePath = importPath.slice("crate::".length).replace(/::/g, "/");
			let crateRoot = fromDir;
			while (crateRoot !== ".") {
				if (existsCached(join(root, crateRoot, "Cargo.toml"))) break;
				const parent = dirname(crateRoot);
				if (parent === crateRoot) break;
				crateRoot = parent;
			}
			const candidates = [`${crateRoot}/${cratePath}.rs`, `${crateRoot}/${cratePath}/mod.rs`];
			for (const c of candidates) {
				const found = tryCandidate(graph, root, c);
				if (found) return found;
			}
			return null;
		}
		// mod X; or use X::Y without crate:: - try sibling module (X.rs or X/mod.rs)
		if (!importPath.includes("::") && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(importPath)) {
			const candidates = [join(fromDir, `${importPath}.rs`), join(fromDir, importPath, "mod.rs")];
			for (const c of candidates) {
				const found = tryCandidate(graph, root, c);
				if (found) return found;
			}
			return null;
		}
		// super:: paths
		if (importPath.startsWith("super::")) {
			const parentPath = importPath.slice("super::".length).replace(/::/g, "/");
			const candidates = [join(dirname(fromDir), `${parentPath}.rs`), join(dirname(fromDir), parentPath, "mod.rs")];
			for (const c of candidates) {
				const found = tryCandidate(graph, root, c);
				if (found) return found;
			}
			return null;
		}
		// Fallback: non-prefixed multi-segment paths start from crate root in Rust 2018+
		// e.g. `use utils::helper::doThing;` == `use crate::utils::helper::doThing;`
		if (importPath.includes("::")) {
			const cratePath = importPath.replace(/::/g, "/");
			let crateRoot = fromDir;
			while (crateRoot !== ".") {
				if (existsCached(join(root, crateRoot, "Cargo.toml"))) break;
				const parent = dirname(crateRoot);
				if (parent === crateRoot) break;
				crateRoot = parent;
			}
			const candidates = [`${crateRoot}/${cratePath}.rs`, `${crateRoot}/${cratePath}/mod.rs`];
			for (const c of candidates) {
				const found = tryCandidate(graph, root, c);
				if (found) return found;
			}
		}
	}

	// Go standard library or external package imports (non-relative) - return as-is
	if (fromExt === ".go") {
		return importPath;
	}

	// Dart non-relative, non-package imports - return as-is
	if (fromExt === ".dart") {
		return importPath;
	}

	// Default: return the import path unchanged (JS/TS bare specifiers, etc.)
	// Rust external crates (e.g. `use serde::Serialize`) are NOT file paths -
	// returning the literal would pollute fileImports with phantom paths
	// (#567 regression of #564). Mirror the JS/TS/Go/Python `return null`
	// branches and treat unresolved Rust specifiers as external.
	if (fromExt === ".rs") return null;
	return importPath;
}

// -- Simple JS/TS import resolution (from filter.ts) ----------------------------

/**
 * Resolve an import specifier to a normalized file path, mirroring
 * the full resolveImport but simplified for JS/TS-only orphan detection.
 * Used to match raw import specifiers (e.g. "./utils") against symbol
 * file paths (e.g. "src/utils.ts").
 *
 * Tries common TypeScript/JavaScript extensions when the specifier
 * does not include one.
 */
export function resolveModulePath(importPath: string, fromFile: string): string {
	if (!importPath.startsWith(".")) return importPath;
	const fromDir = dirname(fromFile);
	let resolved = join(fromDir, importPath);
	resolved = resolved.replace(/\\/g, "/");
	// Normalize leading "./" for consistency with RepoGraph symbol files
	if (resolved.startsWith("./")) resolved = resolved.slice(2);
	return resolved;
}

/**
 * Check if a resolved module path matches a target symbol file.
 * Supports matches with or without file extensions.
 */
export function moduleMatchesFile(resolvedModule: string, targetFile: string): boolean {
	// Normalize path separators: on Windows graph keys use backslashes while
	// resolvedModule uses forward slashes (resolveModulePath forces "/"), so
	// the equality/extension checks below would never match (#660).
	resolvedModule = resolvedModule.replace(/\\/g, "/");
	targetFile = targetFile.replace(/\\/g, "/");
	if (resolvedModule === targetFile) return true;
	const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];
	for (const ext of EXTENSIONS) {
		if (resolvedModule + ext === targetFile) return true;
	}
	// Handle /index.* default imports
	for (const ext of EXTENSIONS) {
		if (resolvedModule + "/index" + ext === targetFile) return true;
	}
	return false;
}

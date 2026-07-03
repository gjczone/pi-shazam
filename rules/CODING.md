# CODING.md

TypeScript coding rules for pi-shazam.

---

## 1. Layer Boundaries

Strict dependency direction: `hooks/` -> `tools/` -> `core/` + `lsp/`

| Layer    | May Import From                           | May NOT Import From              |
| -------- | ----------------------------------------- | -------------------------------- |
| `core/`  | node builtins, npm packages               | `tools/`, `hooks/`, `lsp/`, `pi` |
| `lsp/`   | `core/`, node builtins, npm packages      | `tools/`, `hooks/`, `pi`         |
| `tools/` | `core/`, `lsp/`, npm packages             | `hooks/`                         |
| `hooks/` | `tools/`, `core/`, `lsp/`, `types/`, `pi` | --                               |

Evidence: `index.ts` lines 6-9 (doc comment), `docs/INSTRUCTION.md` section 1.3. `tsc` does not enforce cross-layer rules -- verify manually.

---

## 2. Function Naming

Private/internal helpers prefixed with `_`:

```typescript
export function _logWarn(tag: string, message: string, err?: unknown): void { ... }
export function _resetGitCache(): void { ... }
```

Evidence: `grep "export function _" core/*.ts` -> 3 matches: `_logWarn` (`core/output.ts:427`), `_logInternal` (`core/output.ts:441`), `_resetGitCache` (`core/git-utils.ts:160`). Also used extensively for un-exported module helpers.

---

## 3. File Organization

- **One file = one business concept.** No generic `utils.ts` / `helpers.ts` files spanning multiple domains.
- **File naming:** Tool entry files (the 7 registered tools) use single-word `snake_case.ts` (`rename_symbol.ts`). Internal/utility files in `tools/` may use kebab-case or snake_case as appropriate. All other layers use `kebab-case.ts` (`git-utils.ts`, `treesitter-queries.ts`, `agent-context-guard.ts`).
- **No re-export barrel files.** Files that only forward symbols from another module should be inlined at call sites and deleted.
- **When deleting:** grep all callers -> update them -> delete the old file. No compatibility wrappers or pass-through layers.

Evidence: directory listing `tools/` vs `core/`/`hooks/`/`lsp/` file naming patterns.

---

## 4. Tool Registration Pattern

Every tool exports a `register*` function using the factory:

```typescript
// tools/overview.ts
import { createTool } from "./_factory.js";

export function registerOverview(pi: ExtensionAPI): void {
	createTool(pi, {
		name: "shazam_overview",
		description: "...",
		params: Type.Object({ filter: Type.Optional(Type.String()) }),
		execute(graph, params) {
			/* domain logic */
		},
	});
}
```

**Factory** (`tools/_factory.ts:128` `createTool`) auto-handles: `json`/`maxTokens` param merging, `scanProject(".")`, JSON/text output toggle with standard envelope, `truncateOutput()`, and path traversal guard (`validatePathInProject`).

**Two execution modes:**

- `execute(graph, params)` -- simple; factory handles scan/envelope/truncation.
- `customExecute(toolCallId, params, signal, onUpdate, ctx)` -- complex async tools (LSP); factory only merges params.

**Registration in `index.ts`:** import and call all `register*` in default export.

Evidence: `grep "export function register" tools/*.ts` -> 8 matches. `grep "createTool" tools/*.ts` -> 17 matches (7 call sites + imports). `index.ts` lines 276-283 call each register.

---

## 5. Naming Conventions (Project-Specific)

| Kind            | Pattern             | Examples                                    |
| --------------- | ------------------- | ------------------------------------------- |
| Private helpers | `_camelCase`        | `_logWarn`, `_buildEdges`, `_formatEntry`   |
| Tool names      | `shazam_snake_case` | `shazam_overview`, `shazam_lookup`          |
| Tool labels     | Title Case          | `"Project Overview"`, `"Impact Analysis"`   |
| Constants       | `UPPER_SNAKE_CASE`  | `EXT_TO_LANG`, `NEXT_RULES`, `SKIP_DIRS`    |
| Hook files      | `kebab-case.ts`     | `before-start.ts`, `agent-context-guard.ts` |
| Tool files      | `snake_case.ts`     | `rename_symbol.ts`                          |

**Symbol ID format:** `{file}::{name}::{line}` (e.g., `core/graph.ts::buildGraph::42`). Stable across all tools.

---

## 6. Error Handling

### `_logWarn` Pattern

Defined in `core/output.ts:462`. Standard warning mechanism for `core/` and `tools/` layers:

```typescript
import { _logWarn } from "../core/output.js";

try {
	await parseFile(filePath);
} catch (err) {
	_logWarn("scanner", `Failed to parse ${filePath}`, err);
	return null;
}
```

Behavior: ENOENT errors suppressed (expected for optional binaries); other errors print `[pi-shazam] tag: message - reason`. Evidence: 39 usages across 9 `core/` files.

Hooks layer uses `_logWarn` (from `core/output.js`) for internal diagnostics and `pi.sendMessage()` for user-visible output.

### LSP Degradation

When language server is unavailable, fall back to tree-sitter only. Annotate output with `(tree-sitter only, LSP unavailable)`. Never throw on missing LSP.

Evidence: `tools/lookup.ts:279` `"(tree-sitter only)"`, `lsp/client.ts:20` "falling back to tree-sitter only (issue #441)".

---

## 7. Import Conventions

- **ESM `.js` extensions required** (NodeNext module resolution): `import { foo } from "../core/bar.js"`.
- **No path aliases** (`@/`, `~/`) -- not configured in `tsconfig.json`.
- **`import type` for type-only imports:** `import type { RepoGraph } from "../core/graph.js"`.
- **Group order:** node builtins (`node:path`, `node:fs`) -> npm packages (`typebox`, `vscode-jsonrpc`) -> internal (`../core/graph.js`).

Evidence: `tsconfig.json` `"module": "NodeNext"`. All source imports use `.js` extension per ESM requirement.

---

## 8. Encoding

Use `core/encoding.ts` for ALL file reads. The adaptive reader handles UTF-8 -> GBK -> GB2312 fallback via `iconv-lite`. Never use `fs.readFile` directly for source files.

Evidence: `core/encoding.ts`, `iconv-lite` in `package.json`.

---

## 9. Type Safety

- Import Pi types from `./types/pi-extension.js` (local stub): `ExtensionAPI`, `ExtensionContext`, `AgentToolResult`. Do not redefine.
- Pi tool schemas: `TypeBox` (`tools/_factory.ts`). MCP tool schemas: `Zod` (`mcp/tools.ts`).
- `npm run typecheck` must pass zero errors after every change.

Evidence: `types/pi-extension.d.ts`, `tools/_factory.ts` imports `{ Type } from "typebox"`, `mcp/tools.ts` imports `{ z } from "zod/v4"`.

---

## 10. Cross-Platform Conventions

- **Shell commands in `package.json` scripts**: Use Node.js built-ins over POSIX commands. `node -e "require('fs').rmSync('dist',{recursive:true,force:true})"` replaces `rm -rf dist`. Never use `test -f`, `cp`, `mv` in npm scripts.
- **Path separators**: Always normalize with `path.join()` / `path.resolve()`. When splitting paths, use `filePath.replace(/\\/g, "/").split("/")` (already done in `core/filter.ts:126`, `core/resolve-import.ts:247`).
- **Environment variables**: Fallback chain for home directory: `process.env.HOME || process.env.USERPROFILE`. Windows has no `HOME` in cmd/PowerShell.
- **LSP server discovery**: `lsp/manager.ts` `findInPath` and `trustedUserCandidates` must handle Windows PATH layout. Use `process.platform` branches, never assume POSIX directories.
- **isExecutable**: `lsp/manager.ts:256` win32 branch checks `.exe`/`.cmd`/`.bat`. When adding new LSP servers, verify the command name resolves on Windows (npm global installs create `.cmd` shims).
- **CI**: `windows-latest` runner must be in the CI matrix. Use `fail-fast: false` so Windows failures don't block Linux publish.

## 11. Shared State & Lifecycle

- Shared business rules, cache keys, classification logic belong in `core/` -- single source of truth.
- Module-level caches must reset in `session_shutdown` (`index.ts` lines 108-119).
- When adding state/cache: update create -> read -> update -> invalidate/reset lifecycle.
- Update `AGENTS.md` when adding/changing: module, tool, command, hook, data flow, dependency, build step, layer boundary, or architectural pattern.

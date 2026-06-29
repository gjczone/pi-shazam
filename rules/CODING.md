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

Evidence: `grep "export function _" core/*.ts` -> 2 matches: `_logWarn` (`core/output.ts:462`), `_resetGitCache` (`core/git-utils.ts:160`). Also used extensively for un-exported module helpers.

---

## 3. File Organization

- **One file = one business concept.** No generic `utils.ts` / `helpers.ts` files spanning multiple domains.
- **File naming:** `tools/` files use `snake_case.ts` (`rename_symbol.ts`). All other layers use `kebab-case.ts` (`git-utils.ts`, `treesitter-queries.ts`, `agent-context-guard.ts`).
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

**Factory** (`tools/_factory.ts:124` `createTool`) auto-handles: `json`/`maxTokens` param merging, `scanProject(".")`, JSON/text output toggle with standard envelope, `truncateOutput()`, and path traversal guard (`validatePathInProject`).

**Two execution modes:**

- `execute(graph, params)` -- simple; factory handles scan/envelope/truncation.
- `customExecute(toolCallId, params, signal, onUpdate, ctx)` -- complex async tools (LSP); factory only merges params.

**Registration in `index.ts`:** import and call all `register*` in default export.

Evidence: `grep "export function register" tools/*.ts` -> 9 matches. `grep "createTool" tools/*.ts` -> 10 matches. `index.ts` lines 237-245 call each register.

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

Hooks layer uses `pi.logger.info/warn/error` for Pi-visible logging.

### LSP Degradation

When language server is unavailable, fall back to tree-sitter only. Annotate output with `(tree-sitter only, LSP unavailable)`. Never throw on missing LSP.

Evidence: `tools/lookup.ts:236` `"(tree-sitter only)"`, `lsp/client.ts:20` "falling back to tree-sitter only (issue #441)".

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

## 10. Shared State & Lifecycle

- Shared business rules, cache keys, classification logic belong in `core/` -- single source of truth.
- Module-level caches must reset in `session_shutdown` (`index.ts` lines 108-119).
- When adding state/cache: update create -> read -> update -> invalidate/reset lifecycle.
- Update `AGENTS.md` when adding/changing: module, tool, command, hook, data flow, dependency, build step, layer boundary, or architectural pattern.

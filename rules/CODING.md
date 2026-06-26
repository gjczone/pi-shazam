# CODING.md

TypeScript coding rules for pi-shazam. All source code, comments, JSDoc, type definitions, commit messages, and PR descriptions must be in English.

---

## 1. Layer Boundaries

**Strict dependency direction:** `hooks/` -> `tools/` -> `core/` + `lsp/`

| Layer    | May Import From                               | May NOT Import From                 |
| -------- | --------------------------------------------- | ----------------------------------- |
| `core/`  | node builtins, npm packages                   | `tools/`, `hooks/`, `lsp/`, `pi`    |
| `lsp/`   | `core/`, node builtins, npm packages           | `tools/`, `hooks/`, `pi`            |
| `tools/` | `core/`, `lsp/`, npm packages                  | `hooks/`                            |
| `hooks/` | `tools/`, `core/`, `lsp/`, `types/`, `pi`     | --                                  |

**Enforcement:** `tsc` does not catch cross-layer violations. Verify manually before every commit. If you add an import from `tools/` or `hooks/` into `core/`, or from `hooks/` into `tools/`, the layer boundary is broken.

**Rationale:** `core/` is the pure analysis engine -- zero platform coupling. `lsp/` may import from `core/` for shared utilities (encoding, filter, output). `tools/` composes core + optional LSP enrichment. `hooks/` is the outermost layer with full access.

---

## 2. Function Scope

- A function does ONE thing. If its name needs "and" to describe its purpose, split it.
- Max 80 lines per function. Extract helpers (`_build_*`, `_compute_*`, `_classify_*`) when exceeded.
- Private/internal helpers prefixed with `_` (e.g., `_formatSymbolEntry`, `_buildGraphEdges`, `_logWarn`).

---

## 3. File Boundaries

- One file = one business concept. A file named `utils.ts` or `helpers.ts` over 200 lines must be split by domain.
- Each file exports one primary function or set of related functions for one concern.
- When a single file contains 2+ unrelated domains, extract each into its own file under a shared directory.
- Re-export files that only forward symbols from another module should be inlined at call sites and deleted.
- When migrating: grep all callers first, update them, then delete the old file. No pass-through compatibility layers.

---

## 4. Tool Registration Pattern

Every tool file exports a `register*` function using the factory from `tools/_factory.ts`:

```typescript
// tools/overview.ts
import { createTool } from "./_factory.js";
import type { ExtensionAPI } from "../types/pi-extension.js";
import { Type } from "typebox";

export function registerOverview(pi: ExtensionAPI): void {
  createTool(pi, {
    name: "shazam_overview",
    label: "Project Overview",
    description: "Returns module dependency map, top-10 PageRank files, key dependencies...",
    params: Type.Object({
      filter: Type.Optional(Type.String()),
    }),
    execute(graph, params) {
      // domain logic -- receives pre-scanned RepoGraph + merged params
      // returns plain text output
    },
  });
}
```

**Factory handles:** `json`/`maxTokens` param merging, `scanProject(".")`, JSON/text output toggle with standard envelope (`schema_version`, `command`, `project`, `status`, `result`), `truncateOutput()` when `maxTokens` is set.

**Two modes:**
- `execute(graph, params)` -- simple domain function; factory handles scan, envelope, truncation.
- `customExecute(toolCallId, params, signal, onUpdate, ctx)` -- complex async tools (LSP, multi-branch); factory only merges params. Tool handles its own scan, envelope, truncation.

**Registration in `index.ts`:** Import and call all `register*` functions in the default export. Tool registration order does not matter; hook registration order does (see ARCHITECTURE.md).

---

## 5. Naming Conventions

| Kind            | Style               | Example                                    |
| --------------- | ------------------- | ------------------------------------------ |
| Variables       | `camelCase`         | `graphSummary`, `edgeCount`                |
| Functions       | `camelCase`         | `buildGraph`, `extractSymbols`             |
| Private helpers | `_camelCase`        | `_formatEntry`, `_classifyKind`, `_logWarn` |
| Classes         | `PascalCase`        | `LspManager`, `LspClient`, `TreeSitterAdapter` |
| Types/Interfaces| `PascalCase`        | `ScanResult`, `SymbolInfo`, `RepoGraph`    |
| Enums           | `PascalCase`        | `NextLevel`                                |
| Constants       | `UPPER_SNAKE_CASE`  | `EXT_TO_LANG`, `NEXT_RULES`, `SKIP_DIRS`   |
| Files (tools/)  | `snake_case.ts`     | `find_tests.ts`, `rename_symbol.ts`, `safe_delete.ts` |
| Files (other)   | `kebab-case.ts`     | `git-utils.ts`, `treesitter-queries.ts`, `agent-context-guard.ts` |
| Tool names      | `shazam_snake_case` | `shazam_lookup`, `shazam_overview`         |
| Tool labels     | Title Case          | `"Symbol Lookup"`, `"Impact Analysis"`     |

**Symbol ID format:** `{file}::{name}::{line}` (e.g., `core/graph.ts::buildGraph::42`). Stable across tools -- other tools depend on it.

---

## 6. Error Handling

The `_logWarn` pattern from `core/output.ts` is the standard warning mechanism:

```typescript
import { _logWarn } from "../core/output.js";

try {
  const result = await parseFile(filePath);
} catch (err) {
  _logWarn("scanner", `Failed to parse ${filePath}`, err);
  return null; // graceful degradation
}
```

**`_logWarn` behavior:**
- ENOENT (file not found) -- suppressed entirely (expected when optional binaries are missing).
- Other errors -- prints concise one-line: `[pi-shazam] tag: message - reason`.
- Never passes raw Error objects to `console` (would print full stack trace).

**Rules:**
- Every `catch` block must handle the error (with a log) or re-throw. Empty catch blocks are forbidden.
- Log context: what operation failed, the input context, and the original error message.
- Use `_logWarn(tag, message, err?)` in `core/` and `tools/` layers.
- Use `pi.logger.info/warn/error` in `hooks/` layer for Pi-visible logging.
- LSP degradation: when LSP server is unavailable, fall back to tree-sitter only. Annotate output with `(tree-sitter only, LSP unavailable)`. Never throw on missing LSP.

---

## 7. Import Conventions

- **Relative imports with `.js` extension** (required for ESM with NodeNext module resolution): `import { foo } from "../core/bar.js"`.
- No path aliases (`@/`, `~/`, etc.) -- not configured in this project.
- Group imports in order: node builtins (`node:path`, `node:fs`) -> npm packages (`typebox`, `vscode-jsonrpc`) -> internal (`../core/graph.js`, `../types/pi-extension.js`).
- One import per source file per statement.
- Use `import type` for type-only imports: `import type { RepoGraph } from "../core/graph.js"`.

---

## 8. Formatting Rules

Prettier is the formatter. Configuration (`.prettierrc`):

```json
{
  "semi": true,
  "singleQuote": false,
  "tabWidth": 2,
  "useTabs": true,
  "trailingComma": "all",
  "printWidth": 120,
  "arrowParens": "always"
}
```

**Summary:** Tabs for indentation, double quotes, trailing commas everywhere, 120-char print width, semicolons required, arrow functions always parenthesized.

**Enforcement:** `npm run format:check` in CI. Auto-fix with `shazam_format` tool or `npx prettier --write .`.

---

## 9. No Emoji or Decorative Symbols

Emoji (any Unicode emoji codepoint), Unicode decorative characters, and ASCII art are forbidden in:

- Source files (`.ts`)
- Tool output text returned to the LLM
- Code comments and JSDoc
- Type definitions
- Commit messages and PR descriptions

Allowed: standard ASCII punctuation and Markdown formatting (`#`, `*`, `-`, `` ` ``, `|`).

---

## 10. All English in Source Code

Every artifact that goes into the repository must be in English:

- Source code and variable names
- Code comments (must explain: business purpose, implementation logic, edge cases)
- JSDoc annotations
- Commit messages (conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`)
- PR titles and descriptions
- GitHub Issue content and Release notes
- Tool `description` strings (what the LLM reads to decide when to call)

No Chinese or any other non-English language. This is a hard requirement for this project.

---

## 11. Additional Coding Rules

### Encoding

Use `core/encoding.ts` for ALL file reads. Never assume UTF-8 -- the adaptive reader handles UTF-8 -> GBK -> GB2312 fallback via iconv-lite. Never use `fs.readFile` directly for source files.

### Type Safety

- Import types from `./types/pi-extension.js` (local stub): `ExtensionAPI`, `ExtensionContext`, `AgentToolResult`.
- Do not redefine these types -- use the project's stub.
- Use TypeBox for tool parameter schemas (Pi tools) and Zod for MCP tool schemas.
- `npm run typecheck` must pass with zero errors after every change.

### Deletion Discipline

When replacing a component, function, or module:

1. Grep all callers first.
2. Update all callers in the same change.
3. Delete the old one.
4. No compatibility wrappers or pass-through layers.

### Shared State

- Shared business rules, cache keys, and classification logic belong in `core/` -- single source of truth.
- When adding state/cache/schema fields, update the full lifecycle: create -> read -> update -> invalidate/reset.
- Module-level caches must have a reset path (typically `session_shutdown` hook).

### AGENTS.md Sync

Update `AGENTS.md` whenever you add or change:

- A new module, tool, command, hook, or data flow.
- A new dependency or build step.
- A new layer boundary or architectural pattern.

Keep the "Commands", "Architecture", "Change Map", and "First Places to Inspect" sections current.

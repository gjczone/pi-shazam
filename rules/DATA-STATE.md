# DATA-STATE.md

Rules for module-level state, session lifecycle, persistent cache, and the
RepoGraph data model. Read this before working with any stateful module.

---

## 1. Module-Level State Inventory

Every piece of mutable module-level state in pi-shazam:

| Module                     | State Variable         | Type                        | Purpose                                             | Reset On                 |
| -------------------------- | ---------------------- | --------------------------- | --------------------------------------------------- | ------------------------ |
| `core/scanner.ts`          | `cachedGraph`          | `RepoGraph \| null`         | In-memory project graph cache                       | `session_shutdown`       |
| `core/scanner.ts`          | `cachedProjectPath`    | `string`                    | Path the cached graph was built from                | `session_shutdown`       |
| `core/scanner.ts`          | `_existsCache`         | `Map<string, boolean> \| null` | existsSync result cache for import resolution   | `session_shutdown`       |
| `core/scanner.ts`          | `_scannerAdapter`      | `TreeSitterAdapter \| null` | Singleton tree-sitter adapter                       | `session_shutdown`       |
| `core/scanner.ts`          | `_projectRootOverride` | `string \| null`            | Project root override from Pi context               | `resetProjectRoot()`     |
| `core/scanner.ts`          | `_scanning`            | `boolean`                   | Re-entrancy guard for scanProject                   | Automatic (end of scan)  |
| `tools/lsp_enrich.ts`      | `_openedFileMtimes`    | `Map<string, number>`       | Track didOpen'd files and their mtimes (max 500)    | `session_shutdown`       |
| `tools/lsp_enrich.ts`      | `_ctsCtor`             | `Ctor \| null`              | CancellationTokenSource constructor (lazy loaded)   | Never (module constant)  |
| `tools/_context.ts`        | `_manager`             | `LspManager \| null`        | Shared LSP manager reference for tools              | `session_shutdown`       |
| `tools/_context.ts`        | `_shutdownPromise`     | `Promise<void> \| null`     | In-flight shutdown promise to prevent double-shutdown | On resolve             |
| `hooks/rename-state.ts`    | `_reviewedSymbols`     | `Set<string>`               | Symbols reviewed via shazam_impact --symbol          | `session_start`          |
| `hooks/verify-state.ts`    | `_verifyCalled`        | `boolean`                   | Whether shazam_verify was recently called            | `session_shutdown`, `onNewEdit()` |
| `hooks/verify-state.ts`    | `_lastVerifyTimestamp` | `number`                    | Unix ms of last verify call                          | `session_shutdown`       |
| `hooks/verify-state.ts`    | `_lastVerifyPassed`    | `boolean`                   | Whether last verify verdict was PASS                 | `session_shutdown`       |
| `hooks/verify-state.ts`    | `_reminderSent`        | `boolean`                   | Whether verify reminder already sent this batch      | On verify, on new edit   |
| `hooks/impact-state.ts`    | `_pendingImpact`       | `boolean`                   | Issue created, shazam_impact not yet run             | `session_shutdown`, TTL  |
| `hooks/impact-state.ts`    | `_pendingImpactSetAt`  | `number \| null`            | When pending impact was set (for TTL)                | `session_shutdown`       |

---

## 2. Session Lifecycle

### 2.1 Lifecycle Phases

```
before_agent_start
    |
    +-- Update project root from ctx.cwd (if differs from process.cwd())
    +-- Initialize LSP servers (15s timeout)
    +-- Inject system prompt (overview + shazam guide)
    |
session_start
    |
    +-- Clear rename state (clearRenameState())
    |
[tool cycles: tools run, edits occur, verify/impact flow]
    |
turn_end
    |
    +-- Verify reminder check (stop-verify hook)
    |
session_shutdown
    |
    +-- LSP shutdown (lspManager.shutdown())
    +-- Scanner cache reset (resetCache())
    +-- LSP enrich state reset (resetLspEnrichState())
```

### 2.2 Initialization Order in `index.ts`

1. Create `LspManager(projectRoot, log)`
2. `setLspManager(lspManager)` — shares with tools via `_context.ts`
3. Register `before_agent_start` handler (LSP init + project root update)
4. Register `session_start` handler (clear rename state)
5. Register `session_shutdown` handler (LSP + scanner + lsp_enrich cleanup)
6. Register all hooks (before-start, tool-logger, shazam-guide, pre-edit, safety, stop-verify, failure-recovery, issue-guard, agent-context-guard)
7. Register all commands (shazam-setup, shazam-doctor, shazam-install-git-hooks, shazam-remove-git-hooks, shazam-pre-commit-verify)
8. Register all tools (overview, lookup, impact, verify, changes, format, find_tests, rename_symbol, safe_delete)

**Rule**: The `before_agent_start` handler for LSP init MUST be registered before
`registerBeforeStartHook(pi)` because only the last `before_agent_start` return
value with `{ systemPrompt }` is used.

---

## 3. Persistent Cache

### 3.1 Location

```
~/.cache/repomap/<project-name>_<sha256-prefix>/
```

- `project-name`: last segment of canonical project path
- `sha256-prefix`: first 8 chars of SHA-256 of canonical path
- Managed by `core/cache.ts`: `getProjectCacheDir()`, `saveGraphCache()`, `loadGraphCache()`

### 3.2 Format — SerializedGraphV2

```json
{
  "version": 2,
  "fileMtimes": { "src/index.ts": 1719470000000, ... },
  "graph": { /* serialized RepoGraph */ }
}
```

- Atomic write: write to `.tmp` then `renameSync()` (handles Windows EPERM/EBUSY)
- Size limit: 20MB (`MAX_CACHE_SIZE`) — enforced on both save and load
- Max age: 24 hours (`CACHE_MAX_AGE_MS`) — prevents stale cache in active projects
- Cache is best-effort: directory creation failures degrade gracefully (no caching)

### 3.3 Invalidation

- **mtime-based**: `loadGraphCache()` compares stored mtimes against current `statSync().mtime`
- **Explicit reset**: `resetCache()` in `core/scanner.ts` clears `cachedGraph` + `cachedProjectPath`
- **Session end**: `session_shutdown` handler calls `resetCache()` to prevent memory leaks

### 3.4 Reset Functions

| Function                  | Module                  | What it clears                                |
| ------------------------- | ----------------------- | --------------------------------------------- |
| `resetCache()`            | `core/scanner.ts`       | `cachedGraph`, `cachedProjectPath`, exists cache, scanner adapter |
| `resetProjectRoot()`      | `core/scanner.ts`       | `_projectRootOverride`                        |
| `resetLspEnrichState()`   | `tools/lsp_enrich.ts`   | `_openedFileMtimes` map                       |
| `clearRenameState()`      | `hooks/rename-state.ts` | `_reviewedSymbols` set                        |
| `resetVerifyState()`      | `hooks/verify-state.ts` | All verify tracking flags + timestamps        |
| `resetImpactState()`      | `hooks/impact-state.ts` | Pending impact flag + timestamp               |

---

## 4. Data Model

### 4.1 Symbol — `core/graph.ts`

```ts
interface Symbol {
  id: string;           // "{file}::{name}::{line}" — stable across rebuilds
  name: string;         // Symbol name
  kind: string;         // "function" | "class" | "interface" | "type_alias" | "method" | ...
  file: string;         // Relative file path
  line: number;         // 1-based start line
  endLine: number;      // 1-based end line
  col: number;          // 0-based column
  visibility: "public" | "private" | "exported";
  docstring: string;    // JSDoc/docstring content
  signature: string;    // Full signature text
  returnType: string;   // Return type annotation
  params: string;       // Parameter list text
  pagerank: number;     // PageRank score (computed by core/pagerank.ts)
}
```

### 4.2 Edge — `core/graph.ts`

```ts
interface Edge {
  source: string;       // Source symbol ID
  target: string;       // Target symbol ID
  weight: number;       // Edge weight (1.0 default)
  kind: string;         // "call" | "import" | "type_ref" | "extends" | "implements"
  confidence: number;   // 0.0-1.0 confidence score
}
```

### 4.3 RepoGraph — `core/graph.ts`

```ts
interface RepoGraph {
  symbols: Map<string, Symbol>;                // symbol ID -> Symbol
  outgoing: Map<string, Edge[]>;               // symbol ID -> outgoing edges
  incoming: Map<string, Edge[]>;               // symbol ID -> incoming edges
  fileSymbols: Map<string, string[]>;          // file -> symbol IDs in that file
  fileImports: Map<string, string[]>;          // file -> import module specifiers
  fileCalls: Map<string, [string, number, string][]>;   // file -> [callee, line, caller]
  fileRefs: Map<string, [string, number][]>;            // file -> [ref, line]
  fileImportBindings: Map<string, JSImportBinding[]>;   // file -> import bindings
  nameIndex: Map<string, Symbol[]>;            // symbol name -> all matching symbols (O(1) lookup)
  targetToSources: Map<string, Set<string>>;   // target ID -> source IDs (reverse index)
}
```

### 4.4 Symbol ID Format

`{file}::{name}::{line}` — e.g., `src/tools/overview.ts::executeOverview::45`

**Rule**: Symbol IDs must be stable. Never change the format without updating all
consumers (impact analysis, rename, safe_delete, lookup, verify).

---

## 5. TTL Patterns

### 5.1 Verify State — `hooks/verify-state.ts`

- **TTL**: 5 minutes (`FIVE_MINUTES_MS`)
- **State machine**: `idle -> verified (markVerifyCalled) -> idle (onNewEdit or timeout)`
- `hasRecentVerify()`: true if verify called within last 5 minutes and no new edits
- `hasRecentPassingVerify()`: true if verify called within 5 minutes AND verdict was PASS
- **Verdict parsing**: First tries JSON envelope (`result.verdict`), falls back to regex
  (`/\[FAIL\]/i`, `/Verdict:\s*FAIL/i`). Fail-closed: missing/unknown verdict = not passed.
- **Reminder dedup**: `_reminderSent` prevents repeated turn_end reminders for the same
  batch of unverified edits. Reset on: new edit, verify call, verify error.

### 5.2 Impact State — `hooks/impact-state.ts`

- **TTL**: 30 minutes (`PENDING_IMPACT_TTL_MS`)
- **State machine**: `idle -> pending (setPendingImpact) -> idle (clearPendingImpact or TTL expiry)`
- `hasPendingImpact()`: auto-clears when TTL expires (prevents permanently blocking edits, issue #368)
- Used by `hooks/pre-edit.ts` to block file edits after GitHub issue creation but before
  shazam_impact runs.

### 5.3 Rename State — `hooks/rename-state.ts`

- **TTL**: session-scoped (no explicit TTL; cleared on `session_start`)
- **State machine**: `(empty) -> symbol marked (recordCallChain) -> (empty) via clearRenameState`
- `_reviewedSymbols: Set<string>` tracks which symbols passed `shazam_impact --symbol`
- `shazam_rename_symbol` checks `hasCallChainChecked(symbolName)` before allowing non-dry-run rename

---

## 6. Known Leak Patterns

### 6.1 Orphaned LSP Processes on Timeout

**Scenario**: `before_agent_start` LSP init exceeds 15s timeout.

**Mitigation**: On timeout, the handler calls `lspManager.shutdown()` immediately
(fixes #312). On `session_shutdown`, shutdown is always attempted regardless.

**Current defense**: `index.ts` catches timeout, logs error, and force-shuts down.
The `setLspManager()` in `_context.ts` also awaits previous manager shutdown before
swapping.

### 6.2 Stale Rename State Across Sessions

**Scenario**: Rename state persists from a previous session, allowing a rename
without fresh impact analysis.

**Mitigation**: `session_start` handler calls `clearRenameState()` (fixes #326).

**Current defense**: `_reviewedSymbols` is a `Set<string>` cleared on every session start.

### 6.3 Scanner Cache Not Invalidated on Project Change

**Scenario**: User switches projects but cached graph is from the old project.

**Mitigation**: `resetCache()` is available and called on `session_shutdown`.
`scanProject()` compares `cachedProjectPath` against the requested path and
rebuilds on mismatch.

**Current defense**: `_projectRootOverride` is set per-session from `ctx.cwd`.

### 6.4 Verify Reminder Sent Flag Stuck

**Scenario**: Verify attempt errors out but `_reminderSent` stays true, so future
turn_end events never re-remind.

**Mitigation**: `resetReminderSent()` clears the flag on verify error (fixes #467).

**Current defense**: `resetReminderSent()` is called from error paths in verify tool.

---

## 7. Working With Module-Level State

### 7.1 Adding New State

- Place state in the module closest to its consumer, respecting layer boundaries
- `core/` state: zero Pi/LSP imports (e.g., scanner cache)
- `tools/` state: may import LSP types (e.g., lsp_enrich opened files)
- `hooks/` state: session-scoped, cleared on lifecycle events
- Always provide a `reset*()` function
- Always call the reset from `session_shutdown` or `session_start` as appropriate
- Document the state machine transitions in the module header comment

### 7.2 Testing State

- Every state module exports a `reset*()` function for test teardown
- Call `reset*()` in `beforeEach` or `afterEach` to prevent state leaking between tests
- The `vitest.setup.ts` suppresses known stream-destruction errors from vscode-jsonrpc

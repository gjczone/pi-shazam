# Local CI Checklist

Run these before every `git push`. All commands must exit 0.

Failing any check = broken commit. Do not push until all applicable checks pass.

## Quick Gate (~30 seconds)

Run these three checks before every push. No exceptions.

- [ ] **Type check**: `npx tsc --noEmit`
- [ ] **Format check**: `npx prettier --check .`
- [ ] **Tests**: `npm test` — 0 failures, 0 errors, 0 skipped

If any step fails, fix it before pushing. Do not force-push past a failing type check or test suite.

## Full Verification (~5 minutes)

Run all Quick Gate steps first, then continue with these. Required before creating a PR or preparing a release.

- [ ] **All Quick Gate steps pass** (typecheck + format + tests)
- [ ] **Build**: `npm run build && test -f dist/index.js && test -f dist/index.d.ts`
- [ ] **Integration**: `npx vitest run tests/mcp-integration.test.ts`
- [ ] **Benchmark**: `npx vitest run tests/benchmark.test.ts`
- [ ] **Security audit**: `npm audit --omit=dev`
- [ ] **MCP tool parity**: `npx vitest run tests/definitions-parity.test.ts`
- [ ] **Data integrity**: `npx vitest run tests/data-integrity.test.ts`

### What each step verifies

| Step | What it catches |
|------|----------------|
| Type check | Type errors, missing imports, interface violations |
| Format check | Code style drift (prettier: tabs, double quotes, trailing commas, 120 width) |
| Tests | Logic regressions, broken exports, mock mismatches |
| Build | Compilation failures, missing dist artifacts |
| Integration | MCP server startup, tool registration, JSON schema validation |
| Benchmark | PageRank / graph / scan performance regressions |
| Security audit | Known vulnerabilities in production dependencies |
| MCP parity | Pi tool definitions match MCP tool definitions (name, description, params) |
| Data integrity | Cache consistency, encoding edge cases, graph invariant checks |

## Full CI Shortcut

`npm run ci` runs steps 1-7 automatically (typecheck + test + build + verify dist + integration + benchmark + security).

Use this as a single-command gate when you want the full picture:

```bash
npm run ci
```

Additional steps not in `npm run ci` (run manually):

```bash
npx vitest run tests/definitions-parity.test.ts
npx vitest run tests/data-integrity.test.ts
```

## Conditional Checks (run when applicable)

These are not required for every push but MUST be run in the listed scenarios.

- [ ] **After dependency changes** (`package.json` or `package-lock.json` modified):
  ```bash
  npm install --legacy-peer-deps && npm test
  ```
  Verify no regressions introduced by the dependency update. The `--legacy-peer-deps` flag is required due to tree-sitter grammar peer dependency conflicts.

- [ ] **Before release** (creating a GitHub Release or running `scripts/release.sh`):
  ```bash
  npm run ci && test -f dist/index.js && test -f dist/index.d.ts
  ```
  Also run the MCP parity and data integrity checks listed in Full Verification.

- [ ] **After touching LSP code** (`lsp/client.ts`, `lsp/manager.ts`, `lsp/servers.ts`):
  ```bash
  npx vitest run tests/mcp-integration.test.ts
  ```
  LSP failures are environment-dependent. If a language server is not installed, the test should degrade gracefully (LSP enrichment skipped, tree-sitter only). A hard crash means a regression.

- [ ] **After touching tree-sitter code** (`core/treesitter.ts`, `core/treesitter-queries.ts`):
  ```bash
  npm test
  ```
  Run the full suite because multiple tools depend on tree-sitter output (overview, lookup, find_tests, changes, impact).

- [ ] **After touching graph/pagerank code** (`core/graph.ts`, `core/pagerank.ts`):
  ```bash
  npx vitest run tests/benchmark.test.ts
  ```
  PageRank regressions are not caught by unit tests alone -- the benchmark suite has specific thresholds (1000 nodes < 10s).

## Notes

- There is no eslint in this project. Formatting is handled entirely by prettier.
- macOS-specific test failures are caught by the CI matrix (ubuntu + macos). If you develop on Linux only, the macOS path is covered by CI on push.
- The `security` job in CI uses `continue-on-error: true` so audit failures do not block the pipeline, but you should still address them locally.

# VERIFICATION.md

Rules for the pi-shazam verification pipeline: 6-layer gate, verification commands,
pre-commit hooks, and verification matrix. Read this before committing, merging, or
reporting task completion.

---

## 1. Six-Layer Verification Gate

### Layer 1: Pre-Edit Guard (`hooks/pre-edit.ts`)

**When**: Before the LLM writes to 2+ files or modifies a shared/exported module.
**What**: Triggers `shazam_impact` analysis automatically. Blocks edits if a GitHub
issue was created but `shazam_impact` has not yet run (gated by `impact-state.ts`).
**How**: Hook subscribes to `tool_execution_end`, detects write operations, checks
`hasPendingImpact()`.
**Bypass**: Not bypassable — this is a soft guard that injects context, not a hard block.

### Layer 2: Quick Gate (~30s)

**When**: Before every commit.
**What**: Type check + format check + unit tests.

```bash
npm install --legacy-peer-deps   # ensure deps are current
npx tsc --noEmit                 # type check — zero errors
npx prettier --check .           # format check — zero diffs
npm test                         # unit tests — 0 failures, 0 errors
```

**Pass criteria**: All four commands exit 0.

### Layer 3: Full CI (~5min)

**When**: Before every PR merge. Mirrors `.github/workflows/ci.yml` plus local-only checks.

Steps (13 total):

| #   | Step                          | Command                                                  | Pass Criteria                          |
| --- | ----------------------------- | -------------------------------------------------------- | -------------------------------------- |
| 1   | Install deps                  | `npm install --legacy-peer-deps`                         | Exit 0                                 |
| 2   | Type check                    | `npm run typecheck` (tsc --noEmit)                       | Zero errors                            |
| 3   | Format check                  | `npx prettier --check .`                                 | Zero diffs                             |
| 4   | Unit tests                    | `npm test`                                               | 0 failures, 0 errors                   |
| 5   | Build                         | `npm run build`                                          | Exit 0                                 |
| 6   | Dist artifacts exist          | `test -f dist/index.js && test -f dist/index.d.ts`       | Both files present                     |
| 7   | MCP integration tests         | `npx vitest run tests/mcp-integration.test.ts`           | All pass (requires dist/)              |
| 8   | Benchmarks                    | `npx vitest run tests/benchmark.test.ts`                 | Within time thresholds                 |
| 9   | Security audit                | `npm audit --omit=dev`                                   | 0 vulnerabilities                      |
| 10  | Hook registration count       | grep dist/index.js for 9 register functions              | Count >= 9                             |
| 11  | Pre-publish contract check    | grep dist/ for `pi.logger.` and `pi.typebox`             | Zero matches                           |
| 12  | MCP smoke test                | stdin JSON-RPC initialize + shazam_overview to entry.js  | JSON response with non-empty content   |
| 13  | Pi integration smoke test     | `pi -p "call shazam_overview briefly"`                   | No "Extension error" in output         |

**Quick run**: `npm run ci` (covers steps 1-9, skips format check, hook registration,
contract check, smoke tests).

### Layer 4: `shazam_verify` Tool

**When**: After every write or edit. This is the primary automated verification tool.
**What**: LSP diagnostics (type errors, warnings) + graph analysis (git diff, risk
level, orphan detection, graph diffs).
**Verdict**: `PASS` / `WARN` / `FAIL`.

Flags:

| Flag          | Effect                                            |
| ------------- | ------------------------------------------------- |
| `--quick`     | Git-change-only check (~2s), skip LSP diagnostics |
| `--lspOnly`   | LSP diagnostics only, skip graph analysis          |
| `--preCommit` | Stricter thresholds for pre-commit gate            |
| `--delta`     | Only check changed files                           |
| `--maxFiles`  | Limit number of files to check                     |
| `--noCascade` | Skip cascade analysis                              |
| `--noSecrets` | Skip secrets detection                             |

**State tracking**: `hooks/verify-state.ts` records the verdict with 5-minute TTL.
Fail-closed: unknown/missing verdict = not PASS.

### Layer 5: Git Pre-Commit Hook (`core/git-hooks.ts`)

**When**: Before every `git commit`.
**What**: The hook script detects project language and runs appropriate checks:
- TypeScript/JavaScript: `tsc --noEmit`, eslint or biome
- Rust: `cargo check`, `cargo clippy`
- Go: `go vet`, `golangci-lint`
- Python: `pyright`, `ruff`, `mypy`

**Install**: `/shazam-install-git-hooks` command (installs to `.git/hooks/pre-commit`).
**Remove**: `/shazam-remove-git-hooks` command.
**Bypass**: `git commit --no-verify`.
**Supports**: Git worktrees and custom `GIT_DIR` via `git rev-parse --git-path hooks`.

### Layer 6: GitHub Actions CI (`.github/workflows/ci.yml`)

**When**: On push and PR to `main`.
**What**: 6 parallel jobs across `ubuntu-latest` + `macos-latest`:

| Job               | Checks                                              |
| ----------------- | --------------------------------------------------- |
| typecheck         | `npx tsc --noEmit`                                  |
| test              | `npm test` via vitest                               |
| build             | `npm run build` + dist artifact verification        |
| mcp-integration   | MCP integration tests against built dist            |
| benchmark         | Performance benchmarks                              |
| audit             | `npm audit --omit=dev`                              |

**Coverage gaps** (local CI has these, ci.yml does not):
- Format check (`prettier --check`)
- Hook registration count
- Pre-publish contract check
- MCP smoke test (stdio JSON-RPC)
- Pi integration smoke test

---

## 2. Verification Commands

### Quick Check (~30s)

```bash
npm run typecheck && npx prettier --check . && npm test
```

### Full Local CI (~5min)

```bash
npm run ci
```

Runs: typecheck -> test -> build -> dist verify -> integration -> benchmark -> audit.

### shazam_verify (tool)

```bash
# Quick: git-diff-only (~2s)
shazam_verify --quick

# Full: LSP + graph analysis
shazam_verify

# Pre-commit: stricter thresholds
shazam_verify --preCommit

# JSON output
shazam_verify --json
```

---

## 3. Pre-Commit Hook Details

### Installation Flow

1. User runs `/shazam-install-git-hooks`
2. `core/git-hooks.ts` writes shell script to `.git/hooks/pre-commit`
3. Script is `chmod +x`
4. On commit, script runs language-specific checks
5. Exit non-zero to block commit on failure

### Hook Script Behavior

1. Check for staged changes (`git diff --cached --name-only`)
2. If no staged changes, exit 0 early
3. Detect project language (tsconfig.json, Cargo.toml, go.mod, pyproject.toml, etc.)
4. Run language-specific type check and linter
5. Count errors, exit with error count if > 0

### Bypass

```bash
git commit --no-verify    # bypass all pre-commit hooks
```

---

## 4. Verification Matrix

| Change Type       | Layer 1 (Pre-Edit) | Layer 2 (Quick) | Layer 3 (Full CI) | Layer 4 (shazam_verify) | Layer 5 (Pre-Commit) | Layer 6 (GH Actions) |
| ----------------- | ------------------- | --------------- | ------------------ | ----------------------- | -------------------- | -------------------- |
| Code change       | --                  | Required        | Before merge       | After edit              | On commit            | On push/PR           |
| Tool change       | --                  | Required        | Required           | After edit              | On commit            | On push/PR           |
| Hook change       | --                  | Required        | Required           | After edit              | On commit            | On push/PR           |
| LSP change        | --                  | Required        | Required           | After edit              | On commit            | On push/PR           |
| New tool/hook     | --                  | Required        | Required + MCP parity | After edit          | On commit            | On push/PR           |
| Release           | --                  | Required        | All 13 steps       | Required                | On commit            | On push/PR           |
| Multi-file edit   | Auto-triggered      | Required        | Before merge       | After edit              | On commit            | On push/PR           |
| Shared module edit| Auto-triggered      | Required        | Required           | Required                | On commit            | On push/PR           |

### Tool-Specific Verification

| Tool Change                              | Additional Checks                                    |
| ---------------------------------------- | ---------------------------------------------------- |
| New tool in `tools/`                     | Register in `index.ts`, add MCP handler, update AGENTS.md/SKILL.md |
| Tool parameter change                    | Update both TypeBox (Pi) and Zod (MCP) schemas       |
| Tool output format change                | Verify JSON envelope schema, verify plain text skeleton |
| New hook in `hooks/`                     | Register in `index.ts`, hook registration count >= 9 |
| LSP client/manager change                | Test with at least 2 language servers                |
| Graph algorithm change                   | Verify all RepoGraph consumers produce correct output |

---

## 5. Verification State Tracking

### verify-state.ts

- Tracks whether `shazam_verify` was called recently (5-minute TTL)
- Records verdict (PASS/FAIL) with fail-closed parsing
- `onNewEdit()` resets tracking when new writes occur
- `markReminderSent()` / `wasReminderSent()` dedup turn_end reminders
- `resetReminderSent()` clears on verify error (prevents stuck flag)

### Safety Hooks Integration

- `hooks/safety.ts` uses `hasRecentPassingVerify()` to gate pre-commit
- `hooks/stop-verify.ts` uses `hasRecentVerify()` + `wasReminderSent()` for turn_end reminders
- `hooks/pre-edit.ts` uses `hasPendingImpact()` from impact-state to block edits

---

## 6. Failure Handling

### Verification Failure

1. Stop immediately — do not self-patch tests or silently work around
2. Report what failed and why
3. Do not proceed to next layer until the failure is resolved

### Partial Verification

- If `shazam_verify` returns `WARN`: proceed with caution, document warnings
- If `shazam_verify` returns `FAIL`: must fix before proceeding
- If LSP unavailable: annotate output with "(tree-sitter only, LSP unavailable)"
  and continue — never throw on missing LSP

### Test Environment

- `vitest.config.ts` suppresses known stream-destruction errors from vscode-jsonrpc
- `vitest.setup.ts` installs global process error handlers
- Pre-existing stream errors in test output are expected and not failures

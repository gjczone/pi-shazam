# shazam_verify GitHub Action

Run pi-shazam's full verification (LSP diagnostics + scan + risk assessment) automatically on every PR, with results posted as a PR comment.

## Usage

Add this to your PR-triggered workflow:

```yaml
name: shazam-verify

on:
  pull_request:
  pull_request_target:

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: gjczone/pi-shazam/.github/actions/shazam-verify@main
        with:
          project-root: "." # default: '.'
          fail-on-verdict: "false" # default: 'false' — only post comment
          max-files: "100" # default: 100, forwarded as a verify option (VerifyOptions.maxFiles)
```

## Inputs

| Input             | Description                                                                                                                   | Default | Required |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| `project-root`    | Project root directory (relative to workspace)                                                                                | `.`     | No       |
| `fail-on-verdict` | Fail the check if verdict is FAIL (`true` or `false`)                                                                         | `false` | No       |
| `max-files`       | Maximum files for LSP diagnostics, forwarded as a verify option (resolved into `VerifyOptions.maxFiles` via `run-verify.mjs`) | `100`   | No       |

## How It Works

1. **Setup**: Installs Node.js 22 and runs `npm ci --legacy-peer-deps` + `npm run build`
2. **Verify**: Runs `shazam_verify` with JSON output, computing:
   - LSP diagnostics (via `tsc --noEmit` subprocess fallback when no LSP manager is present)
   - Graph analysis: symbol/edge/file counts, risk level, orphan detection
   - Critical paths: top-5 symbols by incoming caller count (PageRank proxy)
3. **Comment**: Formats the result as a markdown PR comment and posts it via `gh pr comment`

## Output Comment Format

```
## shazam_verify — pi-shazam

**Verdict**: FAIL
**Risk**: high
**Errors**: 2 | **Warnings**: 0 | **Info**: 5
**Edges**: 1209 | **Symbols**: 2899 | **Files**: 122

### Top 3 Errors
- [ERROR] src/foo.ts:42:5 - Property 'x' is missing...

### Affected Critical Paths
- `scanProject` (top by PageRank) — 24 incoming callers

---
Full report: artifact `shazam-verify-report` attached to this run.
```

## Permissions

The action requires `pull-requests: write` permission to post PR comments. If this permission is not available, the comment step is skipped and the result is still written to the step summary.

## Verdicts

- **PASS**: No errors found
- **WARN**: LSP unavailable or diagnostics may be incomplete
- **FAIL**: LSP errors detected or high risk level

When `fail-on-verdict` is set to `true`, the action exits with a non-zero code on a FAIL verdict, causing the job to fail. This enables gating PRs on verification results.

## Running on pi-shazam Itself

This action is **not** added as a PR-triggering workflow in the pi-shazam repo itself. Running `tsc --noEmit` on the full repo is slow (~30s). Consumers should add the workflow to their own repos — pi-shazam's CI already has comprehensive type checking.

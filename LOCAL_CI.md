# LOCAL_CI.md

Local CI checklist for pi-shazam. Run ALL checks before committing or merging.
Replace `npm ci` with `npm install --legacy-peer-deps` when `node_modules/` already exists.

## Prerequisites

- Node.js >= 18
- npm
- Pi CLI (for step 13 only — skip if not installed)

## Checklist

### 1. Install Dependencies

```bash
npm ci --legacy-peer-deps
```

**Pass**: "added N packages" or "up to date", exit code 0.
**Common fix**: `rm -rf node_modules && npm ci --legacy-peer-deps`

### 2. Type Check

```bash
npm run typecheck
```

**Pass**: no output, exit code 0.
**Common fix**: read the TypeScript error, fix the type mismatch, re-run.

### 3. Format Check

```bash
npx prettier --check "*.ts" "core/*.ts" "tools/*.ts" "hooks/*.ts" "lsp/*.ts" "mcp/*.ts" "tests/*.ts"
```

**Pass**: no output, exit code 0.
**Common fix**: `npx prettier --write "*.ts" "core/*.ts" "tools/*.ts" "hooks/*.ts" "lsp/*.ts" "mcp/*.ts" "tests/*.ts"`

### 4. Full Test Suite

```bash
npm test
```

**Pass**: all test files pass, 0 failures.
**Common fix**: read the failing test output, fix the code, re-run.

### 5. Build

```bash
npm run build
```

**Pass**: exit code 0, `dist/index.js` and `dist/index.d.ts` exist.
**Common fix**: fix TypeScript compilation errors, re-run.

### 6. Verify dist Output

```bash
test -f dist/index.js && test -f dist/index.d.ts && echo "OK" || echo "FAIL"
```

**Pass**: prints "OK".
**Common fix**: run `npm run build` first.

### 7. Hook Registration Verification

```bash
grep -c "registerBeforeStartHook\|registerToolLogger\|registerShazamGuide\|registerPreEditGuard\|registerSafetyHooks\|registerStopVerify\|registerFailureRecovery\|registerIssueGuard\|registerAgentContextGuard" dist/index.js
```

**Pass**: output is `9`.
**Common fix**: if output is less than 9, a hook was not registered in `index.ts`.

### 8. MCP Integration Tests

```bash
npx vitest run tests/mcp-integration.test.ts
```

**Pass**: all tests pass.
**Common fix**: ensure `dist/` is built (`npm run build`).

### 9. Benchmark Tests

```bash
npx vitest run tests/benchmark.test.ts
```

**Pass**: all benchmarks pass (within time thresholds).
**Common fix**: performance regressions may need investigation.

### 10. Security Audit (Informational)

```bash
npm audit --omit=dev
```

**Pass**: 0 vulnerabilities, or only non-critical known issues.
**Common fix**: `npm audit fix` for auto-fixable issues.

### 11. Pre-Publish Contract Check

Verify Pi ExtensionAPI contract compliance in compiled output:

```bash
echo "=== Contract Check ===" && \
grep -rl "pi\.logger\." dist/ && echo "FAIL: unprotected logger calls" || echo "OK: no unprotected logger" && \
grep -rl "pi\.typebox" dist/ && echo "FAIL: pi.typebox references" || echo "OK: no pi.typebox" && \
grep "content:" dist/index.js | head -5 && \
echo "=== Done ==="
```

**Pass**: no `pi.logger.` direct calls (should use guarded access), no `pi.typebox` references, `sendMessage` uses string content, tool returns use `[{type:"text", text:...}]`.
**Common fix**: see `docs/INSTRUCTION.md` section 6.8 for debugging guide.

### 12. MCP Smoke Test

```bash
printf '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shazam_hotspots","arguments":{}}}\n' | timeout 15 node dist/mcp/entry.js . 2>/dev/null | tail -1
```

**Pass**: JSON response with `shazam_hotspots` results (non-empty text content).
**Common fix**: check MCP server init in `mcp/entry.ts`, ensure `dist/` is built.

### 13. Pi Integration Smoke Test

```bash
pi -p "call shazam_overview briefly" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

**Pass**: prints "OK" (no extension error in output).
**Common fix**: ensure pi-shazam is installed (`pi install npm:pi-shazam@latest` or symlink `dist/` to `~/.pi/agent/extensions/pi-shazam`).
**Skip**: if Pi CLI is not installed, skip this step and note it in the completion report.

## Quick Run (All at Once)

```bash
npm run ci
```

This single command runs steps 2, 4, 5, 6, 8, 9, 10 in order. Run the remaining steps (3, 7, 11, 12, 13) manually.

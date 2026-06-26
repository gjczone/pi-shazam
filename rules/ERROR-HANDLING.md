# Error Handling Rules

All error handling in pi-shazam follows predictable patterns. Every `catch` branch must either handle the error (with a log) or propagate it. Empty catch blocks are forbidden.

## 1. _logWarn Pattern

The single warning/error logging function for the `core/` layer.

```ts
// Defined in core/output.ts
export function _logWarn(tag: string, message: string, err?: unknown): void
```

- `tag` — identifies the source module (e.g., `"graph"`, `"pagerank"`, `"scanner"`, `"encoding"`)
- `message` — describes what operation failed or what condition triggered the warning
- `err` — optional original error; if an `Error` instance, extracts `.message` for the log line
- Output: `console.error("[pi-shazam] [${tag}] ${message}", errDetail)`
- Used in `core/` only — hooks use `pi.logger`, MCP uses raw `console.error`

Do NOT format the tag with brackets manually — `_logWarn` adds `[pi-shazam]` prefix.

```ts
// Correct
_logWarn("scanner", "failed to read directory", err);

// Wrong — double bracketing
_logWarn("[scanner]", "[pi-shazam] failed to read directory", err);
```

## 2. Catch Block Rules

Every `catch` block must satisfy one of these:

1. **Handle + log**: Log the error with `_logWarn` (core), `pi.logger.warn()` (hooks), or `console.error` (MCP), then return a sensible fallback.
2. **Propagate + log**: Log the error context, then re-throw (or throw a wrapped error).

Every error log must include:
- What operation failed (e.g., "failed to parse file", "LSP initialize timed out")
- Input context (file path, symbol name, tool name — whatever identifies the failed request)
- The original error message (from `err.message` or `String(err)`)

```ts
// Correct — handle with logging
try {
  const tree = parser.parse(source);
} catch (err) {
  _logWarn("treesitter", `failed to parse ${filePath}`, err);
  return null; // graceful fallback
}

// Correct — propagate with logging
try {
  const result = await lspClient.request(method, params);
} catch (err) {
  _logWarn("lsp-client", `request ${method} failed for ${uri}`, err);
  throw err; // caller decides what to do
}

// WRONG — empty catch, silent failure
try {
  await doSomething();
} catch {
  // nothing — forbidden
}
```

## 3. LSP Degradation

When an LSP server is unavailable (not installed, crashed, timed out during init), tools MUST:

1. Log the degradation: `_logWarn("lsp-manager", "LSP unavailable for ${language}, falling back to tree-sitter", err)`
2. Return tree-sitter-only results
3. Annotate the output: append `(tree-sitter only, LSP unavailable)` to the result header
4. NEVER throw an error to the caller — the tool still produces useful output

```ts
// In a tool that optionally enriches with LSP:
const lspResult = await tryLspEnrichment(symbols);
if (!lspResult) {
  output += "\n(tree-sitter only, LSP unavailable)";
} else {
  // merge LSP data into symbols
}
```

Timeout during LSP initialization (15s guard in `lsp/manager.ts`) is treated the same as unavailable.

## 4. Timeout Handling

LSP operations use `Promise.race` with timeout guards. Each language server has a per-language timeout defined in `lsp/servers.ts`.

```ts
const result = await Promise.race([
  lspClient.request(method, params),
  timeout(ms, `LSP ${method} timed out for ${language}`),
]);
```

When a timeout fires:
1. Log the timeout: `_logWarn("lsp-client", "${method} timed out after ${ms}ms for ${language}")`
2. Clean up partially-spawned processes (kill child process if still alive)
3. Return null or degrade to tree-sitter — do NOT leave zombie processes
4. Mark the server as degraded in `lsp/manager.ts` so subsequent calls skip it

LSP init timeout (15s): if `initialize` does not respond within 15 seconds, kill the child process, log the failure, and mark the server as unavailable for the session.

## 5. Factory Error Handling

`createTool` in `tools/_factory.ts` wraps every tool's `execute` function in a top-level try/catch:

```ts
// Simplified from tools/_factory.ts
try {
  const result = await execute(params, ctx);
  return { content: [{ type: "text", text: formatResult(result) }] };
} catch (err) {
  _logWarn(`tool:${name}`, `execution failed`, err);
  return {
    content: [{ type: "text", text: `Error in ${name}: ${err.message}` }],
    isError: true,
  };
}
```

The factory ensures:
- No unhandled exception escapes to the Pi runtime
- The LLM always receives a text response (even on error)
- The error is logged with the tool name as the tag

Tool authors do NOT need to add their own top-level try/catch — the factory handles it. But tools SHOULD catch specific expected errors internally and return meaningful fallbacks (e.g., LSP degradation).

## 6. Tool Error Format

When a tool encounters an error it can handle internally, it returns a structured error in the content envelope:

```ts
return {
  content: [{ type: "text", text: "shazam_lookup: symbol 'foo' not found in project" }],
  isError: false, // not a crash — a valid "not found" response
};
```

When a tool encounters an unexpected error, the factory catches it and returns:

```ts
return {
  content: [{ type: "text", text: "Error in shazam_lookup: connection refused" }],
  isError: true,
};
```

Rules:
- Tools NEVER throw errors that reach the LLM directly — the factory intercepts all throws
- "Not found" and "empty result" are valid responses, not errors (`isError: false`)
- Crash-level failures use `isError: true`
- Error messages are plain text, no stack traces in the response (stack traces go to logs)

## 7. Session Cleanup

On `session_shutdown` (handled in `index.ts`), the extension resets all mutable state:

```ts
pi.on("session_shutdown", () => {
  // Reset scanner cache (core/scanner.ts)
  scannerCache.clear();

  // Reset LSP enrich state
  lspEnrichCache.clear();

  // Shut down all LSP servers gracefully
  lspManager.shutdownAll();

  // Reset audit log writer (flush + close)
  auditLog.flush();
});
```

If any cleanup step fails, log the error with `_logWarn("session", "cleanup step failed", err)` and continue with remaining steps. A cleanup failure must never prevent other cleanup steps from running.

## 8. File Reading

### FileTooLargeError

Files larger than 2MB are rejected before reading:

```ts
const stat = await fs.stat(filePath);
if (stat.size > 2 * 1024 * 1024) {
  throw new FileTooLargeError(filePath, stat.size);
}
```

Tools catch `FileTooLargeError` and return a clear message to the LLM: `"File too large (${size} bytes, limit 2MB): ${path}"`.

### Encoding Fallback

`core/encoding.ts` implements an adaptive reader: UTF-8 -> GBK -> GB2312.

```ts
// Try UTF-8 first (fast path)
// If decode produces replacement characters (U+FFFD), try GBK
// If GBK fails, try GB2312
// If all fail, return UTF-8 result with a warning log
```

Encoding failures log: `_logWarn("encoding", "failed to decode ${filePath} with all encodings, using UTF-8 with replacement chars")`.

Never assume UTF-8 for source files — always use the adaptive reader from `core/encoding.ts`.

## 9. Git Operations

`core/git-utils.ts` wraps git commands with `safeGitExec`:

```ts
const result = safeGitExec(["log", "--oneline", "-10"], { cwd: projectRoot });
if (!result) {
  _logWarn("git-utils", "git log failed, returning empty history");
  return [];
}
```

`safeGitExec`:
- Spawns `git` as a child process with a timeout (default 10s)
- Returns `{ stdout, exitCode }` on success
- Returns `null` on timeout, spawn failure, or non-zero exit code
- Logs failures with `_logWarn("git-utils", ...)` before returning null
- Never throws — callers check for null and provide fallback behavior

Do NOT use `child_process.exec` directly for git — always use `safeGitExec` to get consistent timeout handling and error logging.

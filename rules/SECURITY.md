# Security Rules

pi-shazam runs as a local extension inside the Pi coding agent. It reads source code and metadata from the user's project — it does not serve a network, handle user authentication, or manage credentials. The security surface is narrow but real: file path access, secret leakage through logs, and child process management.

## 1. Path Traversal Prevention

All file access goes through `validatePathInProject` in `tools/_factory.ts`.

```ts
function validatePathInProject(filePath: string, projectRoot: string): string {
  const resolved = path.resolve(projectRoot, filePath);
  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside project root`);
  }
  // Also check symlink targets — resolve real path and re-validate
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(projectRoot + path.sep) && real !== projectRoot) {
    throw new Error(`Symlink escape blocked: ${filePath} points outside project root`);
  }
  return resolved;
}
```

Rules:
- Every tool that accepts a file path parameter MUST validate it through `validatePathInProject`
- The factory (`createTool`) calls `validatePathInProject` automatically for tools that declare a `file` or `path` parameter
- Raw `fs.readFile`, `fs.stat`, etc. MUST NOT be called with unvalidated paths anywhere in `tools/` or `core/`
- `..` segments, absolute paths outside the project, and symlinks pointing outside the project are all rejected
- The project root comes from `getEffectiveRoot()` in `core/scanner.ts`

## 2. Secret Redaction

`core/redact.ts` strips secrets from all strings before they enter any log channel.

**What gets redacted**:
- API key patterns: `sk-*`, `api_key=*`, `apikey: *`
- Auth headers: `Authorization: Bearer *`, `token=*`
- Password fields: `password=*`, `passwd=*`, `secret=*`
- Known env var values: values of `OPENAI_API_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, etc. if they appear in strings
- Long hex/base64 strings (>32 chars) in contexts like headers, URLs, config values

**When to redact**:
- Before writing to the audit log (`core/audit-log.ts`)
- Before passing tool parameters to `_logWarn`
- Before including file contents or config values in log messages
- Never trust "this code path won't see secrets" — redact defensively

```ts
import { redact } from "./redact.js";

// Redact before any logging
_logWarn("scanner", `loaded config: ${redact(JSON.stringify(config))}`);
auditLog.write({ params: redact(JSON.stringify(params)) });
```

## 3. File Access Scope

pi-shazam is a READ-ONLY extension. Tools read source code and metadata; they do not write to the project.

- Tools may read any file within the validated project root
- Tools MUST NOT write, create, or delete files in the project (the `shazam_format` tool delegates to external formatters that write, but pi-shazam itself does not)
- Tools MUST NOT read files outside the project root (path traversal check prevents this)
- `core/encoding.ts` reads files for decoding — it uses the validated path from the factory
- `core/scanner.ts` walks the project directory tree — it respects `.gitignore` and never follows symlinks outside the project

## 4. Git Operation Safety

All git commands go through `safeGitExec` in `core/git-utils.ts`.

```ts
function safeGitExec(args: string[], opts: { cwd: string }): { stdout: string; exitCode: number } | null {
  // Only whitelisted git subcommands are allowed
  const allowed = ["log", "diff", "show", "status", "rev-parse", "ls-files", "blame", "remote"];
  if (!allowed.includes(args[0])) {
    _logWarn("git-utils", `blocked non-whitelisted git command: ${args[0]}`);
    return null;
  }
  // Spawn git with the given args — no shell interpolation
  const proc = spawn("git", args, { cwd: opts.cwd, timeout: 10_000 });
  // ...
}
```

Rules:
- Never use `shell: true` when spawning git — prevents command injection via crafted filenames or branch names
- Only whitelisted git subcommands are allowed (log, diff, show, status, rev-parse, ls-files, blame, remote)
- `cwd` is always the validated project root
- Timeout: 10 seconds per git command — kills the process on timeout
- `safeGitExec` never throws — returns null on any failure

## 5. LSP Protocol Security

LSP servers communicate over stdio (stdin/stdout pipes), not network sockets.

- Child processes are spawned with `spawn("node", [serverPath], { stdio: "pipe" })` — no shell, no network
- Each LSP server is scoped to a single language and a single project root
- LSP servers are shut down on `session_shutdown` — no orphan processes
- LSP initialization has a 15-second timeout — prevents hanging on broken servers
- If an LSP server crashes, it is marked as unavailable for the session — no automatic restart loop
- LSP servers receive file URIs within the project root only (validated before sending)

## 6. MCP Server Security

The MCP server (`mcp/entry.ts`, `mcp/tools.ts`) runs as a stdio JSON-RPC server.

- Transport: stdio only — no HTTP, no WebSocket, no network exposure
- The MCP server inherits the same `validatePathInProject` checks as Pi tools
- MCP tool parameters are validated through Zod schemas before execution
- The MCP server does not store state between requests beyond session-scoped caches
- No authentication is needed because the MCP server communicates over local stdio (the Pi agent spawns it as a child process)

## 7. Dependency Security

- `npm audit --omit=dev` runs in CI on every push/PR (GitHub Actions security job)
- Dependabot is enabled for automated dependency update PRs
- `tree-sitter` is pinned via `overrides` in `package.json` — do not change the pin without verifying the native addon builds on all CI platforms (ubuntu, macos)
- `--legacy-peer-deps` is required for install — tree-sitter peer dependency conflicts are known and intentional
- New dependencies require justification: is the functionality already available in Node.js standard library or an existing dependency?

## 8. No User Authentication

pi-shazam does not implement authentication or authorization. It runs inside the local Pi agent process, which already controls access. There are no:

- Login flows
- Token generation or validation
- Permission checks between users
- Session tokens or cookies

The extension trusts the Pi agent to control access. If the Pi agent invokes a tool, the tool executes.

## 9. No Secrets in Source

- No API keys, tokens, passwords, or credentials in source code, test fixtures, or configuration files
- No `.env` files committed to the repository (`.gitignore` includes `.env`)
- Test fixtures that need dummy credentials use clearly-fake values (e.g., `sk-test-fake-key-not-real`)
- CI secrets are injected via GitHub Actions secrets, never hardcoded in workflow files

## 10. Process Isolation

LSP servers are spawned as child processes with limited scope:

```ts
const child = spawn("node", [serverPath], {
  stdio: "pipe",
  cwd: projectRoot,
  env: {
    // Inherit PATH and minimal env vars needed for the language server
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // Do NOT forward all env vars — prevents secret leakage to child processes
  },
});
```

On `session_shutdown`:
1. Send LSP `shutdown` + `exit` notifications to each server
2. Wait up to 5 seconds for graceful exit
3. `SIGKILL` any servers still alive after the timeout
4. Log each cleanup step (success or failure)

Orphaned LSP processes waste resources and hold file locks. The 5-second kill-after-shutdown ensures no server lingers.

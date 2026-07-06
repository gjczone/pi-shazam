## User System Rules

# Rules

## 0) Hard Boundaries (Highest Priority — Never Violated)

### Scope Lock

- **NEVER** introduce new third-party dependencies unless the task explicitly requires it.
- **NEVER** create new files unrelated to the current task.
- **NEVER** modify interface signatures, function behavior, or code formatting outside the task scope under the guise of "maintaining compatibility" or "unifying style."
- **NEVER** proactively refactor existing code under the guise of "function too long" or "messy file structure" unless explicitly instructed.
- **NEVER** delete, merge, or relocate modules without an explicit migration instruction.

**Opportunistic fixes — fix on sight, report in completion report:**
When encountering a pre-existing issue that is unrelated to the current task, fix it immediately — without asking — if and only if ALL of the following are true:

1. No refactoring involved (moving, renaming, restructuring code).
2. No new dependencies required.
3. The fix is self-contained and low-risk (a typo, a missing null check, an unused import, an empty catch block, an obvious off-by-one, a broken log message).

If the issue fails any of the three criteria above — stop, do not touch it, and report it under **Follow-up** in the completion report.

### Data & Security

- **NEVER** fabricate tool outputs, test results, logs, or any external confirmations.
- **NEVER** hardcode where constants, enums, or shared definitions are appropriate.
- **NEVER** skip security review on auth, permissions, secrets, file access, execution paths, or user input.
- **NEVER** duplicate shared business rules, cache keys, or classification logic across multiple locations.

### Quality Gates

- **NEVER** ignore type errors, build errors, failing tests, or command failures.
- **NEVER** validate only the happy path — boundary cases and repeated runs must be covered.
- **NEVER** modify or add code paths outside the task scope in order to handle edge cases — discover the issue, report it, do not self-extend.
- Every `except` / `catch` / `match Err` branch **MUST** either handle the error with a log or propagate it. Empty catch blocks are forbidden. Log: what operation failed, the input context, and the original error message.

---

## 1) Basic Norms

- Address the user as `老板`.
- Default to Simplified Chinese. Use English only for code, commands, technical terms, commit types, and tool names.
- Treat the user as non-technical unless they clearly ask for engineering detail. Explain in business terms first.
- Do not dump code unless the user asks for it.
- Comments added to code must explain: business purpose, implementation logic, and edge cases. Use Chinese; avoid jargon.

---

## 2) Tool Invocation

- When a relevant skill or MCP tool exists for the task, invoke it directly — do not ask first.
- **NEVER** fall back to raw shell commands when a better tool alternative is available.

---

## 3) Execution Discipline

### 3.1 Before Acting

- State assumptions explicitly when meaning is unclear — never guess.
- When the requested approach is heavier than necessary, propose a simpler path.
- When business logic or domain rules are unclear, ask once rather than assume.

### 3.2 Change Discipline

- Do only what the user asked. Prefer the smallest change that solves the request.
- Fix broken things on sight — build errors, missing dependencies, type errors, broken commands — regardless of whether the current task introduced them.
- Apply opportunistic fixes per the criteria in §0 Scope Lock. Do not ask for permission; just fix and report under **Opportunistic fixes** in the completion report.
- Do not touch naming, formatting, or architecture preferences unless the task explicitly requires it.
- When replacing a component, function, or module: ① grep all references, ② update them, ③ delete the old file — all in the same change. No leftover references. No compatibility wrappers.

### 3.3 Verifiable Execution

- Execute autonomously. Do not stop and ask for confirmation between steps — keep going until the task is complete or you hit a blocker.
- Stop and ask only when: (a) verification fails and you cannot fix it, (b) business meaning or domain rules are unclear, (c) a destructive action has no safety net, or (d) the user explicitly asked to be consulted.
- On verification failure: stop immediately, report what failed and why. Do not self-patch tests or silently work around the failure.
- For multi-step tasks, list the plan first, then execute all steps autonomously:

```text
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
```

---

## 4) Completion Report

Trigger only when the task or milestone is fully completed:

```markdown
老板您好，已完成 [一句话总结]。

**做了什么**

- [业务层面]：[通俗说明变更内容和原因]

**结果**

- [什么变了]：[用户视角描述变更效果]
- [影响范围]：[受影响的页面 / 功能 / 模块]

**已确认**

- [验证项 1]：[验证方式和结果]
- [验证项 2]：[验证方式和结果]

**顺手修了这些** _(非本次任务引入的遗留问题，已在本次一并修复)_

- [文件 / 位置]：[问题描述，做了什么]

**需要你决策**

- [需人工判断的事项]：[为什么需要你决定]

**待跟进** _(发现但未修复——改动太大或风险过高)_

- #N：[简述] → [为何未在本次修复]
```

---

## 5) Code Structure

### 5.1 Function Scope

- **NEVER** write a function that does more than one thing. If the name needs "and" to describe its purpose, split it.
- This rule applies only to new or modified functions within the task scope. **NEVER** proactively refactor existing functions on this basis.

### 5.2 File Boundaries

- One file = one business concept. Any file with a generic name (`utils`, `helpers`, `common`, `misc`) that spans multiple unrelated domains is a boundary violation — regardless of line count.
- When a file directly touched by the task contains 2+ unrelated domains, extract each into its own file. **NEVER** proactively scan the codebase to clean this up.
- **NEVER** create a module file that only re-exports another module's symbols — inline the imports at call sites instead.

### 5.3 API Calls

- Before writing any code that calls your project's own backend (regardless of language or library), read `rules/api.d.ts` first. Endpoint path, HTTP method, request shape, and response shape must match exactly.
- External library APIs → query `context7` MCP. Your project's own API → read `rules/api.d.ts`. **NEVER** guess either.
- If `rules/api.d.ts` does not exist or the needed endpoint is missing: update `rules/api.d.ts` first, then implement both backend and frontend together. **NEVER** write client code against an undocumented endpoint.

---

## 6) Toolchain

- **Python**: ALL operations MUST go through `uv`. **NEVER** invoke `python`, `pip`, `venv`, or `virtualenv` directly.
- **JavaScript / TypeScript**: Use the package manager already present in the project (`npm`, `yarn`, or `pnpm` — determined by the lockfile). **NEVER** mix package managers in the same project.
- When the project's toolchain is not covered above, check the project-level for toolchain rules before using any default.

<general-project-rules>

# pi-shazam

Pi coding agent native codebase awareness extension. "Shazam" — like the superhero whose power comes from multiple deities, pi-shazam unifies the strength of multiple analysis engines (repomap/aider, pi-lens, serena MCP, tree-sitter, LSP) into one coherent interface for the agent.

Rewrites the Python CLI project [repomap](https://github.com/gjczone/repomap) as a native Pi extension in TypeScript. All analysis capabilities register as first-class Pi tools — LLM sees them alongside `read`/`write`/`bash` with no distinction.

## shazam Tools — USE THEM

You have access to pi-shazam — 7 code analysis tools. You WILL use every one of them. They are NOT optional.

**`shazam_overview` is ALREADY in your context.** It was auto-injected before you started reading. READ it. The project structure, top files, and hotspots are right there above this section. If you can see the overview output in your context — Do NOT call `shazam_overview`. If you do NOT see it — call it immediately. It is the single most important tool. You cannot work blind.

Here are the other 6 tools. You MUST call them. Memorize them. Use them or fail.

| Tool                   | What it does                                                                       | You MUST call it when                                                             |
| ---------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `shazam_lookup`        | Symbol/file details — hover info, type hierarchy, callers, callees, concept search | You need to understand any symbol, file, or "how is X implemented"                |
| `shazam_impact`        | Blast radius — every file, symbol, and test affected by your change                | BEFORE editing shared or exported modules. Do NOT guess what you'll break.        |
| `shazam_verify`        | Post-edit gate — LSP diagnostics, graph analysis, PASS/WARN/FAIL                   | AFTER every write. Run it. Read the verdict. If it says FAIL or WARN, fix it NOW. |
| `shazam_changes`       | Git change summary with symbol-level detail and risk level                         | You edited things and need to know what actually changed                          |
| `shazam_format`        | Auto-fix formatting — supports multiple formatters                                 | `shazam_verify` reports format errors                                             |
| `shazam_rename_symbol` | Cross-file symbol rename with atomic writes and safety gate                        | Renaming ANY symbol. Do NOT manually find-and-replace.                            |

If a tool errors or is unavailable, try once more, then work around it. But you MUST try it first. These tools are the difference between a working change and a broken build.

## When to Read Rules Files

- Read `rules/CODING.md` before writing or modifying code. Layer boundaries and tool registration patterns live here.
- Read `rules/REVIEW-RULES.md` before performing a code review. NEVER submit findings that violate the DO NOT REPORT rules.

## When to Read Companion Files

| File                      | Directive                                                                                                                                                                                                    | Trigger                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `docs/INSTRUCTION.md`     | Single source of truth for Pi extension API contracts, architecture layer boundaries, tool registration patterns, content format contracts, release process, and verification gates. Read before any change. | Any code change, tool/hook creation, or release                                     |
| `docs/kimi-code-hooks.md` | Kimi Code shell hooks version mapping, maintenance checklist, and update procedure. Read before releasing a new version.                                                                                     | Version release, tool name/behavior changes                                         |
| `SKILL.md`                | Documents every shazam tool's parameters, behavior, return format, and usage patterns with concrete examples. Do not guess parameter names or output shapes.                                                 | Before calling a shazam tool for the first time, or when uncertain about parameters |
| `README.md`               | User-facing setup, install, and feature descriptions.                                                                                                                                                        | User onboarding, release announcements                                              |
| `CHANGELOG.md`            | Release history and version tracking. Update when releasing a new version.                                                                                                                                   | Before creating a release, before investigating regression                          |

## Project Snapshot

- **Language**: TypeScript (ES2022, ESM), Node.js >= 18
- **What it does**: Codebase graph construction (tree-sitter AST -> symbols -> dependencies -> PageRank), LSP integration, and safe code modification tools
- **Platforms**: Linux, macOS, Windows — all tree-sitter grammars ship prebuilt binaries for linux/darwin/win32 (x64 + arm64). On Windows, all 4 shells (cmd, PowerShell 5/7, Git Bash) are supported; `npm run build` works everywhere, `bash scripts/ci.sh` requires Git Bash.
- **Package manager**: npm (lockfile: `package-lock.json`)
- **Deployment**: Pi extension (symlink dist/ into `~/.pi/agent/extensions/pi-shazam`) + MCP server (`npx pi-shazam-mcp`)
- **Test framework**: vitest, 48 TypeScript source files, tests in `tests/`
- **Key boundaries**: `core/` must never import from `tools/`, `hooks/`, or `lsp/`. Zero HTTP framework, zero ORM, zero auth.
- **Primary risk areas**: tree-sitter grammar version compatibility, LSP JSON-RPC frame parsing, encoding fallback (UTF-8/GBK/GB2312), MCP/Pi tool definition sync, Windows LSP server discovery (SAFE_PATH_DIRS)

## Commands

| Command                          | Purpose                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- |
| `npm install --legacy-peer-deps` | Install dependencies (legacy-peer-deps required for tree-sitter)           |
| `npm run build`                  | Compile TS -> `dist/`                                                      |
| `npm run typecheck`              | `tsc --noEmit` — type validation without emit                              |
| `npm run dev`                    | `tsc --watch` — incremental compilation                                    |
| `npm test`                       | Run all tests via vitest                                                   |
| `bash scripts/ci.sh`             | Local CI quick gate — run before every commit (Windows: requires Git Bash) |
| `bash scripts/release.sh`        | Release operations — run through ALL checklist items when publishing       |

## Architecture

4 layers: `hooks/` -> `tools/` -> `core/` + `lsp/`. Dependency direction is one-way downward. `core/` has zero Pi or LSP imports. Tools compose core and enrich with LSP data. Hooks call tool logic and inject into LLM context via `pi.sendMessage()`.

## API Surface

- **Pi Extension API**: `types/pi-extension.d.ts` — self-contained `ExtensionAPI` type stub. Import as `from "./types/pi-extension.js"`. Key types: `ExtensionAPI`, `ExtensionContext`, `AgentToolResult`.
- **Tool registration**: `tools/_factory.ts` → `createTool(pi, { name, label, description, params, execute })`. Registration happens in `index.ts` default export.
- **MCP server**: `mcp/tools.ts` uses Zod schemas from `tools/definitions.ts`. MCP and Pi tools MUST stay in sync within the same PR.

## Data & State Flows

| Variable / Cache                 | Type                        | Purpose                                                     | Reset trigger                                         |
| -------------------------------- | --------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Module-level cached scan results | In-memory                   | `scanProject()` result reused across tools within a session | New tool call with `scanProject` flag, or session end |
| LSP client connections           | Process                     | Spawned language server processes per language              | Session end, server crash, or explicit shutdown       |
| Audit log                        | File (`~/.pi/hooks/audit/`) | All tool invocations                                        | Log rotation (10 MB cap)                              |
| Graph cache                      | In-memory                   | RepoGraph built from tree-sitter parse                      | File change detected, or session end                  |
| LSP per-file mtime cache (#641)  | In-memory                   | `LspManager._openedFileMtimes` records mtimeMs at didOpen   | Invalidate on mtime change, server restart, or shutdown |
| Project config cache (#630)      | In-memory                   | `core/config.ts` parses `.pi-shazam/config.json` once       | Process restart (no hot-reload); reset via test helper |

## Security

- **Project root validation**: `core/scanner.ts` `getEffectiveRoot()` validates project root; never trust user-supplied paths blindly.
- **File path sanitization**: All file paths resolved against project root; path traversal (`../`) outside root is rejected.
- **Secrets detection**: `shazam_verify` includes secrets detection. Never commit files containing detected secrets.
- **Audit logging**: All tool invocations logged to audit file with timestamp, tool name, and parameters. Sensitive parameter values are redacted.
- **LSP processes**: Auto-spawned language servers run as child processes; stdin/stdout communication only, no network exposure.

## Debugging Guide

| Symptom                               | Likely cause                             | Check                                                                    |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| Tree-sitter parse returns empty       | Grammar version mismatch                 | `package.json` `overrides` for `tree-sitter` version                     |
| LSP tool returns "(tree-sitter only)" | Language server not installed or crashed | Run `/shazam-doctor` for a full health check                             |
| LSP communication errors              | JSON-RPC frame parsing                   | `lsp/client.ts` Content-Length header mismatch, incomplete reads         |
| LSP server not found on Windows       | SAFE_PATH_DIRS is POSIX-only             | `lsp/manager.ts` findInPath filter; install LSP server globally via npm  |
| Build fails on Windows (`rm -rf`)     | POSIX command in prebuild script         | `package.json` prebuild uses Node.js `fs.rmSync` since v0.24.4           |
| Tool not appearing in Pi              | Registration missing                     | Verify `register*` called in `index.ts`; check Pi extension loading logs |
| Test failures with stream errors      | vscode-jsonrpc pre-existing issue        | `vitest.setup.ts` suppresses these; not a real bug                       |
| Encoding errors on source read        | Non-UTF-8 file                           | `core/encoding.ts` adaptive reader tries UTF-8 -> GBK -> GB2312          |

## Change Map

- **Adding a new tool**: Create `tools/<name>.ts` with `register*` function using `createTool()` from `tools/_factory.ts` -> import and call in `index.ts` -> append Next recommendation rules to `NEXT_RULES` in `core/output.ts` -> sync in `mcp/tools.ts` and `mcp/README.md` -> add docs to `SKILL.md` -> update `README.md` if user-facing tool list changed.
- **Modifying an existing tool handler**: When you change the dispatch logic, parameter validation, path guards, error handling, or routing in any `tools/*.ts` `register*` or `execute*` function, you MUST mirror the change in the corresponding MCP handler in `mcp/tools.ts`. After both sides are updated, run `bash scripts/check-mcp-parity.sh` to confirm parity. See #616 and #618 for the root cause of drift.
- **Adding a new hook**: Create `hooks/<name>.ts` with `register*` calling `pi.on(...)` -> import and call in `index.ts`. Hooks listen to lifecycle events (`tool_execution_start`, `before_agent_start`, etc.); they do not return tools to LLM.
- **Adding a new language**: Add grammar to `core/treesitter.ts` EXT_TO_LANG map -> add tree-sitter query in `core/treesitter-queries.ts` -> add LSP server config in `lsp/servers.ts`.
- **Wiring a shared utility**: Add function to appropriate `core/*.ts` -> export -> import in consumers from `../core/<file>.js`. `core/` is the only valid home for cross-layer utilities.
- **Changing LSP protocol**: Modify `lsp/client.ts` -> verify `lsp/manager.ts` lifecycle -> test with at least 2 different language servers.
- **Changing tool output format**: Update the specific `tools/*.ts` formatter -> verify JSON envelope schema (all tools support `{ json: true }`).
- **Changing tool names, adding/removing tools, or changing tool behaviors**: After the code change, read `docs/kimi-code-hooks.md` -> run through the checklist -> update version mapping table -> sync Kimi Code shell hooks if needed. Kimi Code uses MCP format (`mcp__pi-shazam__shazam_<name>`); old tool names in shell hooks will silently fail on Kimi Code.
- **Adding platform support**: Check `process.platform` branches in `lsp/manager.ts` (isExecutable, findInPath, SAFE_PATH_DIRS, trustedUserCandidates). Ensure all shell commands in `package.json` scripts use Node.js built-ins (no `rm -rf`, `test -f`). Add platform-specific paths to `lsp/servers.ts` LSP server specs if needed. Verify `mcp/entry.ts` env var fallbacks (HOME vs USERPROFILE). Add `windows-latest` to CI matrix.
- **Migrating a flag to config file (#630)**: Drop the flag from `tools/definitions.ts` schema (both TypeBox and Zod), add a reader in `core/config.ts` if one does not exist, update the dispatcher resolution chain (call value > config value > hard-coded default), update `hooks/precommit-verify.ts` if it set the flag literally, document in `SKILL.md` and `docs/INSTRUCTION.md`. Verify `bash scripts/check-mcp-parity.sh` stays at 10/10.

## First Places to Inspect

- `index.ts` — extension entry, all registrations
- `core/treesitter.ts` — language support, symbol extraction
- `core/graph.ts` — dependency graph construction
- `core/output.ts` — shared utilities: `_logWarn`, `NEXT_RULES`, `truncateOutput`
- `core/scanner.ts` — project scanning, `getEffectiveRoot()`
- `core/config.ts` — `.pi-shazam/config.json` loader (#630)
- `core/risk.ts` — risk-level assessment for verify and pre-commit
- `core/baseline.ts` — graph-baseline diff for risk and orphan tracking
- `lsp/client.ts` — LSP JSON-RPC communication
- `lsp/manager.ts` — LSP server lifecycle + per-file mtime cache (#641)
- `tools/_factory.ts` — tool registration factory
- `tools/_dispatchers.ts` — shared MCP/Pi dispatch layer (#618)
- `vitest.config.ts` — test runner config (suppresses pre-existing stream errors)
- `docs/INSTRUCTION.md` — single source of truth for contracts and conventions

## Project-Specific Rules

- **LANGUAGE RULE**: All source code, code comments, JSDoc, commit messages, PR titles/descriptions, GitHub Issue content, and GitHub Release notes MUST be written in English. No Chinese or any other non-English language in any artifact that goes into the repository.
- **No emoji or decorative symbols**: Forbidden in all source files, tool output, code comments, and commit messages. Only standard ASCII punctuation and Markdown formatting allowed. Exception: `AGENTS.md` and `SKILL.md`.
- **Tool output must be clean**: No emoji, no decorative Unicode, no ANSI escape codes. No "friendly" filler phrases. Consistent heading hierarchy. Truncation explicitly flagged. No trailing whitespace.
- **Tool naming**: Prefix all tools with `shazam_` to avoid conflicts.
- **Symbol IDs**: Format as `{file}::{name}::{line}` — keeps repomap convention.
- **LSP degradation**: When LSP is unavailable, fall back to tree-sitter only. Annotate output with "(tree-sitter only, LSP unavailable)". Never throw on missing LSP.
- **Encoding**: Always use `core/encoding.ts` adaptive reader (UTF-8 -> GBK -> GB2312). Never assume UTF-8.
- **TDD**: Write the test first for every slice. Verify it fails, implement, verify it passes, commit.
- **PR scope**: One vertical slice per PR — build a complete module (core + tool + typecheck), then merge. No big-bang PRs.

## Agent Checklist

Before committing or creating a PR, verify ALL of the following:

- [ ] `bash scripts/ci.sh` passes all checks
- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm test` passes — 0 failures, 0 errors, 0 skipped
- [ ] `npm run build` succeeds with `dist/index.js` and `dist/index.d.ts` present
- [ ] `shazam_verify` called after all code changes (PASS/WARN verdict, no FAIL)
- [ ] Read `docs/INSTRUCTION.md` if any contract, layer, or convention was changed
- [ ] AGENTS.md updated if new module/tool/command/hook/data flow was added
- [ ] MCP tools synced in `mcp/tools.ts` if Pi tools were changed
- [ ] Kimi Code shell hooks checked via `docs/kimi-code-hooks.md` checklist if tool names/behaviors changed
- [ ] `docs/kimi-code-hooks.md` version mapping table updated for this release
- [ ] All code comments, JSDoc, commit messages in English (LANGUAGE RULE)
- [ ] Address user as 老板 (user-level rules)
- [ ] Completion report format (user-level rules)
- [ ] No empty catch blocks — handle or propagate every error (user-level rules)

</general-project-rules>

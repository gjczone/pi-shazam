## User System Rules

# Rules

## 0) Hard Boundaries (Highest Priority — Never Violated)

### Scope Lock

- **NEVER** introduce new third-party dependencies unless the task explicitly requires it.
- **NEVER** create new files unrelated to the current task.
- **NEVER** modify interface signatures, function behavior, or code formatting outside the task scope under the guise of "maintaining compatibility" or "unifying style."
- **NEVER** proactively refactor existing code under the guise of "function too long" or "messy file structure" unless explicitly instructed.
- **NEVER** delete, merge, or relocate modules without an explicit migration instruction.

**Opportunistic fixes — fix on sight, report in completion report:** When you hit a pre-existing issue unrelated to the current task, fix it immediately (no ask) if and only if it is self-contained, low-risk, needs no new dependency, and involves no refactoring (typo, missing null check, unused import, empty catch, obvious off-by-one, broken log). Otherwise stop, do not touch it, and report it under **Follow-up**.

### Data & Security

- **NEVER** fabricate tool outputs, test results, logs, or any external confirmations.
- **NEVER** hardcode where constants, enums, or shared definitions are appropriate.
- **NEVER** skip security review on auth, permissions, secrets, file access, execution paths, or user input.
- **NEVER** duplicate shared business rules, cache keys, or classification logic across multiple locations.

### Quality Gates

- **NEVER** ignore type errors, build errors, failing tests, or command failures.
- **NEVER** validate only the happy path — boundary cases and repeated runs must be covered.
- **NEVER** modify or add code paths outside the task scope to handle edge cases — discover, report, do not self-extend.
- Every error branch (`catch` / `except`) **MUST** log (what failed, input context, original error message) or propagate. Empty catch blocks are forbidden.

---

## 1) Basic Norms

- Address the user as `老板`.
- Default to Simplified Chinese. Use English only for code, commands, technical terms, commit types, and tool names.
- Treat the user as non-technical unless they clearly ask for engineering detail. Explain in business terms first.
- Do not dump code unless the user asks for it.
- Code comments must explain business purpose, implementation logic, and edge cases, in Chinese, without jargon.

---

## 2) Tool Invocation

- When a relevant skill or MCP tool exists, invoke it directly — do not ask first.
- **NEVER** fall back to raw shell commands when a better tool alternative is available.

---

## 3) Execution Discipline

### 3.1 Before Acting

- State assumptions explicitly when meaning is unclear — never guess.
- When the requested approach is heavier than necessary, propose a simpler path.
- When business logic or domain rules are unclear, ask once rather than assume.

### 3.2 Change Discipline

- Do only what the user asked. Prefer the smallest change that solves the request.
- Fix broken things on sight (build errors, missing deps, type errors, broken commands) regardless of source.
- Apply opportunistic fixes per §0 Scope Lock; report them under **Opportunistic fixes**.
- Do not touch naming, formatting, or architecture preferences unless the task explicitly requires it.
- When replacing a component/function/module: ① grep all references, ② update them, ③ delete the old file — all in the same change. No leftover references, no compatibility wrappers.

### 3.3 Verifiable Execution

- Execute autonomously; do not stop to ask between steps. Stop and ask only when: (a) verification fails and you cannot fix it, (b) business meaning or domain rules are unclear, (c) a destructive action has no safety net, or (d) the user asked to be consulted.
- On verification failure: stop immediately, report what failed and why. Do not self-patch tests or silently work around the failure.
- For multi-step tasks, list the plan first, then execute all steps autonomously (`1. [Step] -> verify: [check]`).

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

- **NEVER** write a function that does more than one thing. Applies to new/modified functions only; never proactively refactor existing ones.
- One file = one business concept. Generic names (`utils`, `helpers`, `common`, `misc`) spanning unrelated domains are boundary violations. **NEVER** create a module that only re-exports another module's symbols — inline imports at call sites.
- This project has **zero HTTP framework, zero ORM, zero auth** — there is no backend API to call. Do not introduce network/service calls.

---

## 6) Toolchain

- **Python**: ALL operations MUST go through `uv`. **NEVER** invoke `python`, `pip`, `venv`, or `virtualenv` directly.
- **JavaScript / TypeScript**: Use the package manager already present (lockfile decides `npm`/`yarn`/`pnpm`). **NEVER** mix package managers in the same project.

<general-project-rules>

# pi-shazam

Pi coding agent native codebase awareness extension. Rewrites the Python CLI [repomap](https://github.com/gjczone/repomap) as a native Pi extension in TypeScript. All analysis capabilities register as first-class Pi tools — the LLM sees them alongside `read`/`write`/`bash`.

## shazam Tools — USE THEM

You have access to pi-shazam — 7 code analysis tools. You WILL use every one of them. They are NOT optional.

**`shazam_overview` is ALREADY in your context.** If you can see its output, do NOT call it; if you do not, call it immediately — it is the single most important tool.

| Tool                   | What it does                                                                       | You MUST call it when                                                      |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `shazam_overview`      | Project structure, top files, hotspots, entry points, key data structures          | First entry / need project structure                                       |
| `shazam_lookup`        | Symbol/file details — hover info, type hierarchy, callers, callees, concept search | Understand any symbol, file, or "how is X implemented"                     |
| `shazam_impact`        | Blast radius — every file, symbol, and test affected by your change                | BEFORE editing shared or exported modules. Do NOT guess what you'll break. |
| `shazam_verify`        | Post-edit gate — LSP diagnostics, graph analysis, PASS/WARN/FAIL                   | AFTER every write. Run it. If FAIL or WARN, fix it NOW.                    |
| `shazam_changes`       | Git change summary with symbol-level detail and risk level                         | Need to know what actually changed                                         |
| `shazam_format`        | Auto-fix formatting — multiple formatters                                          | `shazam_verify` reports format errors                                      |
| `shazam_rename_symbol` | Cross-file symbol rename with atomic writes and safety gate                        | Renaming ANY symbol. Do NOT manually find-and-replace.                     |

If a tool errors or is unavailable, try once more, then work around it. But you MUST try it first.

## When to Read Rules Files

- `rules/CODING.md` — before writing or modifying code (layer boundaries, tool registration patterns).
- `rules/REVIEW-RULES.md` — before a code review. NEVER submit findings that violate its DO NOT REPORT rules.
- `docs/INSTRUCTION.md` — single source of truth for API contracts, layer boundaries, tool registration, content-format contracts, release process, verification gates. Read before any change.

## Project Snapshot

- **Language**: TypeScript (ES2022, ESM), Node.js >= 18.
- **What it does**: Codebase graph construction (tree-sitter AST -> symbols -> dependencies -> PageRank), LSP integration, safe code modification tools.
- **Platforms**: Linux, macOS, Windows (cmd, PowerShell 5/7, Git Bash). All tree-sitter grammars ship prebuilt binaries (linux/darwin/win32, x64 + arm64); no C++ compiler needed. `npm run build` works in any shell; `bash scripts/ci.sh` needs Git Bash.
- **Package manager**: npm (`package-lock.json`). **Deployment**: Pi extension (symlink `dist/` into `~/.pi/agent/extensions/pi-shazam`) + MCP server (`npx pi-shazam-mcp`).
- **Architecture**: 4 layers `hooks/` -> `tools/` -> `core/` + `lsp/`. Dependency direction is one-way downward; `core/` has zero Pi/LSP imports. `mcp/` is a standalone entry that may import `tools/`/`core/`/`lsp/` but NOT `hooks/`.
- **On-disk cache**: V3.2 ProtoBuf (columnar + string table + kind int) is the default; V2 JSON stays readable for backward compat. Magic-header routing in `loadGraphCache` upgrades legacy caches in place.
- **Test framework**: vitest. **TDD**: write the failing test first, implement, verify green, commit.
- **Primary risk areas**: tree-sitter grammar version compat, LSP JSON-RPC framing, encoding fallback (UTF-8/GBK/GB2312), MCP/Pi tool-definition sync, Windows LSP discovery, V3 cache magic-byte routing.

## Commands

| Command                          | Purpose                                                   |
| -------------------------------- | --------------------------------------------------------- |
| `npm install --legacy-peer-deps` | Install deps (legacy-peer-deps required for tree-sitter)  |
| `npm run build`                  | Compile TS -> `dist/`                                     |
| `npm run typecheck`              | `tsc --noEmit`                                            |
| `npm run dev`                    | `tsc --watch`                                             |
| `npm test`                       | Run all tests via vitest                                  |
| `bash scripts/ci.sh`             | Local CI gate — run before every commit (needs Git Bash)  |
| `bash scripts/release.sh`        | Release checklist — run through ALL items when publishing |

## Key Decisions (preserve these)

- **MCP / Pi tool parity**: The 7 tools are registered once and shared. Any change to a tool's dispatch, params, path guards, error handling, or routing MUST be mirrored in `mcp/tools.ts`, then verified with `bash scripts/check-mcp-parity.sh`. MCP and Pi must stay in sync within the same PR.
- **Windows path normalization**: The runtime targets Windows-native (incl. `.exe` packaging). All user-supplied paths MUST be normalized at ingress via `core/path-utils.ts` `normalizePathInput()` (handles Git-Bash `/c/foo` and WSL `/mnt/c/foo`). Never call `realpathSync`/`statSync`/`spawn` on a raw user path without it.
- **No `process.exit` at module load**: `mcp/entry.ts` must exit only inside `main()` behind the `isMainModule` guard, deferred via `setImmediate` where I/O is pending — a module-top-level exit kills the host worker under vitest (see #676).
- **LSP graceful degradation**: When LSP is unavailable, fall back to tree-sitter only; annotate output "(tree-sitter only, LSP unavailable)". Never throw on missing LSP.
- **Encoding**: Always read source via `core/encoding.ts` adaptive reader (UTF-8 -> GBK -> GB2312). Never assume UTF-8.
- **Platform support**: New platform logic MUST branch on `process.platform === "win32"` explicitly; never assume POSIX separators/paths. Verify `package.json` scripts use Node built-ins (no `rm -rf`), and add `windows-latest` to CI matrix.

## Change Workflow (high level)

- **Add a tool**: `tools/<name>.ts` with `register*` -> call in `index.ts` -> append NEXT rules in `core/output.ts` -> sync `mcp/tools.ts` + `mcp/README.md` -> docs in `SKILL.md` -> update `README.md` if the user-facing tool list changed.
- **Modify a tool handler**: mirror in `mcp/tools.ts`, run `bash scripts/check-mcp-parity.sh`.
- **Add a hook**: `hooks/<name>.ts` with `register*` -> call in `index.ts`. Hooks listen to lifecycle events; they do not return tools.
- **Add a language**: grammar in `core/treesitter.ts` EXT_TO_LANG -> query in `core/treesitter-queries.ts` -> LSP spec in `lsp/servers.ts`.
- **Add/extend a typed result**: expose `buildXxxResult(...): XxxResult` (typed data) + `executeXxxJson(result, root): string` (envelope wrapper); keep `executeXxx` for text backward-compat. Compute new fields inside `buildXxxResult` (single source of truth).
- **Cache / wire-format change**: define in `core/graph.proto` (source of truth) + mirror in `core/proto-schema.ts`; guard serialize/deserialize by a 4-byte magic header; bump the magic byte on breaking changes; keep the V2 JSON fallthrough path.
- **Tool name / behavior change**: after the code change, read `docs/kimi-code-hooks.md`, run its checklist, update the version-mapping table, sync Kimi Code shell hooks (MCP format `mcp__pi-shazam__shazam_<name>`).
- For any change touching a contract/layer/convention, read `docs/INSTRUCTION.md` first.

## First Places to Inspect (by layer)

- Entry / registration: `index.ts`
- Core graph & scan: `core/scanner.ts` (getEffectiveRoot), `core/graph.ts`, `core/treesitter.ts`, `core/output.ts`, `core/cache.ts`, `core/proto-schema.ts`, `core/graph.proto`
- LSP: `lsp/client.ts` (JSON-RPC), `lsp/manager.ts` (lifecycle, mtime cache)
- Tools: `tools/_factory.ts` (registration), `tools/_dispatchers.ts` (shared Pi/MCP dispatch)
- Contracts: `docs/INSTRUCTION.md`

## Project-Specific Rules

- **LANGUAGE RULE**: All source code, comments, JSDoc, commit messages, PR titles/descriptions, Issue content, and Release notes MUST be in English. No Chinese in any repository artifact.
- **No emoji / decorative symbols** in source, tool output, comments, or commits. Standard ASCII + Markdown only. Exceptions: `AGENTS.md`, `SKILL.md`.
- **Tool output must be clean**: no emoji, no decorative Unicode, no ANSI codes, no filler phrases, consistent heading hierarchy, truncation flagged, no trailing whitespace.
- **Tool naming**: prefix all tools with `shazam_`.
- **Symbol IDs**: `{file}::{name}::{line}` (repomap convention).
- **PR scope**: one vertical slice per PR (build a complete module: core + tool + typecheck), then merge. No big-bang PRs.

## Agent Checklist (before commit / PR)

- [ ] `bash scripts/ci.sh` passes all checks
- [ ] `npm run typecheck` — zero errors
- [ ] `npm test` — 0 failures / 0 errors / 0 skipped
- [ ] `npm run build` — `dist/index.js` + `dist/index.d.ts` present
- [ ] `shazam_verify` called after all code changes (PASS/WARN, no FAIL)
- [ ] `docs/INSTRUCTION.md` read if contract/layer/convention changed
- [ ] AGENTS.md updated if new module/tool/command/hook/data flow added
- [ ] MCP tools synced in `mcp/tools.ts` if Pi tools changed
- [ ] Kimi Code shell hooks checked via `docs/kimi-code-hooks.md` if tool names/behaviors changed
- [ ] All comments/JSDoc/commits in English (LANGUAGE RULE)
- [ ] Address user as 老板; completion-report format used; no empty catch blocks

</general-project-rules>

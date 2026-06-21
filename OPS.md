# OPS.md

Release operations checklist for pi-shazam. Run through EVERY step in order when publishing a new version.

## Prerequisites

- All code changes merged to `main`
- Working directory clean (`git status` shows no uncommitted changes)
- Local CI passed (all 13 steps in `LOCAL_CI.md`)
- GitHub CLI (`gh`) authenticated

## Phase 1: Documentation Sync

Before bumping the version, ensure ALL documentation is up to date with the changes in this release.

### 1.0 General .md Sync Check

- [ ] Scan ALL changed files in this release and cross-check against the .md file list below
- [ ] If language count changed: update README.md, AGENTS.md, SKILL.md, mcp/README.md
- [ ] If new tool/hook/command added: update AGENTS.md tables, SKILL.md, mcp/README.md
- [ ] If project description/philosophy changed: update README.md intro
- [ ] If community interaction policy changed: update AGENTS.md

### 1.1 CHANGELOG.md

- [ ] Add `## [X.Y.Z] - YYYY-MM-DD` section at the TOP (after the header, before older versions)
- [ ] Include subsections: Features & Enhancements, Bug Fixes, Refactoring, Documentation, Other
- [ ] Reference issue/PR numbers for each entry (e.g., `fix(#NNN)`, `enhance(#NNN)`)
- [ ] Keep entries concise but informative

### 1.2 README.md

- [ ] Update tool reference tables if tools were added/removed/changed
- [ ] Update hook table if hooks were added/removed
- [ ] Update Quick Start if install commands changed
- [ ] Update version badge if it references a specific version
- [ ] Update architecture diagram if layer structure changed

### 1.3 AGENTS.md

- [ ] Update version number (handled by `release.sh`, but verify)
- [ ] Update Architecture tree if new files were added/removed
- [ ] Update Registered Tools table if tools changed
- [ ] Update Hooks table if hooks changed
- [ ] Update Registered Commands table if commands changed
- [ ] Update Change Map if development workflows changed

### 1.4 SKILL.md

- [ ] Add/remove tool documentation if tools were added/removed
- [ ] Update parameter descriptions if tool params changed
- [ ] Update usage examples if tool behavior changed significantly

### 1.5 mcp/README.md

- [ ] Update tool table if MCP tools were added/removed/changed
- [ ] Update client setup examples if config format changed

### 1.6 docs/INSTRUCTION.md

- [ ] Update version number (handled by `release.sh`, but verify)
- [ ] Update API contracts if tool output formats changed
- [ ] Update architecture layer boundaries if layers changed

## Phase 2: Version Bump & Build

### 2.1 Run Release Script

```bash
./scripts/release.sh patch   # or minor, major
```

This script handles:
- `npm version` bump in `package.json`
- Version sync to `mcp/entry.ts`, `AGENTS.md`, `docs/INSTRUCTION.md`
- `npm run build` + `npm test`
- Git commit + annotated tag `vX.Y.Z`
- Push to `origin main --tags`
- Auto-extract current version section from `CHANGELOG.md` for detailed GitHub Release notes
- `gh release create vX.Y.Z` with CHANGELOG-derived notes (triggers npm publish via GitHub Actions)
- Auto-delete merged remote temporary branches (cleanup after PR merge)
- Wait for npm publish
- Update local Pi extension + global npm install

### 2.2 Verify Version Sync

After `release.sh` completes, verify version consistency:

```bash
echo "package.json: $(node -p 'require("./package.json").version')"
grep 'version:' mcp/entry.ts | head -1
grep '0\.[0-9]*\.[0-9]*' AGENTS.md | head -3
```

All four surfaces should show the same version:
- `package.json`
- `mcp/entry.ts`
- `AGENTS.md`
- `docs/INSTRUCTION.md`

## Phase 3: Local CI (Full Run)

Run ALL 13 steps from `LOCAL_CI.md`:

```bash
npm run ci
```

Plus the manual steps (3, 7, 11, 12, 13) not covered by `npm run ci`.

Every step must pass before proceeding.

## Phase 4: Verify GitHub Release

### 4.1 Verify Release Notes Content

`release.sh` auto-extracts the current version section from `CHANGELOG.md` and uses it as GitHub Release notes (including upgrade instructions and full changelog diff link). Verify the generated notes are complete:

```bash
gh release view vX.Y.Z
```

**Pass**: Release notes contain "What's Changed", upgrade instructions, and full changelog link. NOT just "See CHANGELOG for details."

If the notes are incomplete or malformed, fix with:

```bash
gh release edit vX.Y.Z --notes "$(cat <<'EOF'
# vX.Y.Z

## What's Changed

<content from CHANGELOG.md>

## Upgrade

\`\`\`bash
pi install npm:pi-shazam@latest
\`\`\`

**Full Changelog**: https://github.com/gjczone/pi-shazam/compare/vX.Y.Z-1...vX.Y.Z
EOF
)"
```

### 4.2 Commit CHANGELOG.md

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG.md for vX.Y.Z"
git push origin main
```

## Phase 5: Post-Release Verification

### 5.1 npm Registry

```bash
# Wait 30s for npm registry propagation, then:
npm view pi-shazam version
```

**Pass**: output matches the released version.

### 5.2 Global npm Install

```bash
npm install -g pi-shazam@latest --legacy-peer-deps
```

**Pass**: installs the new version without errors.

### 5.3 Pi Extension

```bash
pi install npm:pi-shazam@latest
pi -p "call shazam_overview briefly" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

**Pass**: prints "OK".

### 5.4 MCP Server

```bash
printf '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"shazam_overview","arguments":{}}}\n' | timeout 15 node $(npm root -g)/pi-shazam/dist/mcp/entry.js . 2>/dev/null | tail -1
```

**Pass**: JSON response with tool results.

## Phase 6: Cleanup

### 6.1 Verify Temporary Branch Cleanup

`release.sh` auto-deletes merged remote branches (Step 8.5). Verify:

```bash
git branch -r | grep -v "origin/main\|origin/HEAD"
```

**Pass**: no temporary branches remaining. If any remain, delete manually:

```bash
git push origin --delete <branch-name>
```

### 6.2 Git Clean State

```bash
git status
git branch
```

**Pass**: on `main` branch, working directory clean, only `main` local branch.

## Release Checklist (Summary)

```
[ ] 1.  CHANGELOG.md updated with new version entry
[ ] 2.  README.md synced (tool tables, hooks, quick start)
[ ] 3.  AGENTS.md synced (architecture, tools, hooks, commands)
[ ] 4.  SKILL.md synced (tool docs, params)
[ ] 5.  mcp/README.md synced (tool table, client setup)
[ ] 6.  docs/INSTRUCTION.md synced (contracts, version)
[ ] 7.  release.sh executed successfully
[ ] 8.  Version consistent across 4 surfaces
[ ] 9.  Local CI (all 13 steps) passed
[ ] 10. GitHub Release notes verified (auto-generated from CHANGELOG)
[ ] 11. CHANGELOG.md committed and pushed
[ ] 12. npm registry shows correct version
[ ] 13. Global npm install verified
[ ] 14. Pi extension updated and smoke-tested
[ ] 15. MCP server smoke-tested
[ ] 16. Temporary branches cleaned up (auto-deleted by release.sh, verified)
[ ] 17. Git clean state confirmed
```

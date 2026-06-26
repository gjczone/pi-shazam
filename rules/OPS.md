# Release Operations

Release process for pi-shazam. This project uses `scripts/release.sh` for automated releases published to npm via GitHub Actions.

## Release Flow Overview

```
Phase 0: Verify CI  -->  Phase 1: Docs Sync  -->  Phase 2: Version Bump
    -->  Phase 3: Local CI  -->  Phase 4: GitHub Release
    -->  Phase 5: Post-Release Verify  -->  Phase 6: Cleanup
    -->  Phase 7: File Update Audit
```

## Phase 0: Verify Main Branch CI is Green

Before starting any release, confirm the main branch has a passing CI pipeline.

```bash
gh run list --branch main --limit 5
```

All recent workflow runs on `main` must show `success`. If any are `failure` or `in_progress`, fix them first. A release built on a broken main branch will produce a broken npm package.

## Phase 1: Documentation Sync

Update ALL companion files before bumping the version. The release.sh script handles version surfaces, but documentation content is the developer's responsibility.

**Files to review and update:**

| File | What to update |
|------|---------------|
| `CHANGELOG.md` | Add a new section for the release version with all user-visible changes |
| `README.md` | Update feature list, tool table, usage examples if any tool behavior changed |
| `AGENTS.md` | Update tool table, architecture notes, dependency references, agent checklist |
| `SKILL.md` | Update tool parameter docs, return format docs, usage examples for changed tools |
| `mcp/README.md` | Update MCP tool table, parameter docs, usage examples for changed tools |
| `rules/*.md` | Update any rules affected by the release (new tools, changed patterns, new deps) |
| `docs/INSTRUCTION.md` | Update contracts, layer docs, version references, tech stack notes |

**Validation:** Every tool that was added, changed, or removed in this release cycle must have its documentation updated in ALL files that reference it.

## Phase 2: Version Bump

`scripts/release.sh` handles version bumps automatically across all version surfaces:

| Surface | File | What changes |
|---------|------|-------------|
| npm package | `package.json` | `version` field |
| MCP entry | `mcp/entry.ts` | version constant |
| Agent docs | `AGENTS.md` | version references |
| Contracts | `docs/INSTRUCTION.md` | version references |

Run the release script:

```bash
./scripts/release.sh
```

The script will:
1. Prompt for the new version (semver)
2. Update all version surfaces listed above
3. Extract the CHANGELOG section for the release version
4. Run local CI (typecheck + test + build + verify dist)
5. Create the git commit and tag
6. Create the GitHub Release with CHANGELOG notes
7. Trigger the publish workflow
8. Clean up merged remote branches

**Do not manually edit version strings.** Let release.sh handle all version surfaces to keep them in sync.

## Phase 3: Local CI

`release.sh` runs local CI automatically, but if you need to run it manually:

```bash
npm run ci
```

This covers: typecheck + test + build + verify dist + integration + benchmark + security.

Refer to `rules/LOCAL_CI.md` for the full checklist. ALL steps must pass before proceeding.

Additional checks not in `npm run ci`:

```bash
npx vitest run tests/definitions-parity.test.ts
npx vitest run tests/data-integrity.test.ts
```

## Phase 4: GitHub Release

`release.sh` creates the GitHub Release automatically. If you need to create one manually:

1. Ensure you are on `main` with a clean working tree
2. The release tag must match the version in `package.json`
3. Release notes must come from the `CHANGELOG.md` section for this version
4. Creating the GitHub Release triggers `publish.yml`

**publish.yml workflow:**
```
npm ci --legacy-peer-deps --> npx tsc --noEmit --> npm test --> npm run build --> npm publish
```

The workflow runs typecheck, test, and build before publishing. If any step fails, the publish is aborted.

## Phase 5: Post-Release Verification

After `publish.yml` completes, verify the release landed correctly.

**npm registry check:**
```bash
npm view pi-shazam version
npm view pi-shazam dist-tags
```

The version must match what you released, and `latest` must point to it.

**Smoke test:**
```bash
npm pack pi-shazam@latest
tar -xzf pi-shazam-*.tgz
test -f package/dist/index.js
test -f package/dist/index.d.ts
rm -rf pi-shazam-*.tgz package/
```

Verify the published tarball contains `dist/index.js` and `dist/index.d.ts`.

**MCP server check:**
```bash
npx pi-shazam-mcp --version
```

The MCP entry point should report the released version.

## Phase 6: Cleanup

`release.sh` automatically deletes merged remote branches during cleanup. If you need to clean up manually:

```bash
git fetch --prune
git branch --merged main | grep -v 'main\|develop' | xargs -n 1 git branch -d
```

Verify git is in a clean state:
```bash
git status
git log --oneline -3
```

The working tree must be clean and on `main`.

## Phase 7: File Update Audit

After the release is published, audit ALL companion files for staleness. This catches documentation drift that Phase 1 might have missed.

**Checklist:**

- [ ] `CHANGELOG.md` — new section exists for released version, links are correct
- [ ] `README.md` — tool list matches actual registered tools, install instructions are current
- [ ] `AGENTS.md` — tool table is current, architecture section is accurate, version references updated
- [ ] `SKILL.md` — all tool parameter docs match actual tool definitions
- [ ] `mcp/README.md` — MCP tool table matches `mcp/tools.ts` registrations
- [ ] `docs/INSTRUCTION.md` — version references, contracts, tech stack section are current
- [ ] `rules/` — all rules files reflect current project state
- [ ] `package.json` — version matches release, dependencies are accurate
- [ ] `mcp/entry.ts` — version constant matches release

## Release Checklist

Complete all items in order. Do not skip any.

- [ ] 0. Main branch CI is green (`gh run list --branch main`)
- [ ] 1. CHANGELOG.md has a section for this version
- [ ] 2. README.md updated if user-facing features changed
- [ ] 3. AGENTS.md updated (tool table, architecture, deps)
- [ ] 4. SKILL.md updated (tool params, return formats, examples)
- [ ] 5. mcp/README.md updated (MCP tool table)
- [ ] 6. docs/INSTRUCTION.md updated (contracts, version refs)
- [ ] 7. `./scripts/release.sh` completed successfully
- [ ] 8. npm registry shows correct version (`npm view pi-shazam version`)
- [ ] 9. Smoke test passed (tarball contains dist artifacts)
- [ ] 10. File update audit completed (Phase 7 checklist)

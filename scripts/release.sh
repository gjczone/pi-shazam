#!/bin/bash
# pi-shazam release script — ensures local Pi and MCP are always in sync
#
# Usage: ./scripts/release.sh [patch|minor|major]
#
# This script:
# 1. Bumps version in package.json
# 2. Syncs version to all surfaces (mcp/entry.ts, AGENTS.md, docs/INSTRUCTION.md)
# 3. Builds and tests
# 4. Commits and tags
# 5. Pushes to GitHub
# 6. Creates GitHub Release (triggers npm publish)
# 7. Updates local Pi extension
# 8. Updates global npm install

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[release]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[warn]${NC} $1"
}

error() {
    echo -e "${RED}[error]${NC} $1"
    exit 1
}

# Parse arguments
BUMP_TYPE="${1:-patch}"
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
    error "Usage: $0 [patch|minor|major]"
fi

# Step 1: Check working directory is clean
log "Step 1: Checking working directory..."
if [[ -n $(git status --porcelain) ]]; then
    error "Working directory not clean. Commit or stash changes first."
fi

# Step 2: Run tests
log "Step 2: Running tests..."
npm run typecheck || error "Type check failed"
npm test || error "Tests failed"

# Step 3: Bump version
log "Step 3: Bumping version ($BUMP_TYPE)..."
NEW_VERSION=$(npm version "$BUMP_TYPE" --no-git-tag-version)
NEW_VERSION="${NEW_VERSION#v}" # Remove 'v' prefix
log "New version: $NEW_VERSION"

# Step 4: Sync version to all surfaces
log "Step 4: Syncing version to all surfaces..."

# mcp/entry.ts
sed -i "s/version: \"[0-9]*\.[0-9]*\.[0-9]*\"/version: \"$NEW_VERSION\"/" mcp/entry.ts

# AGENTS.md
sed -i "s/[0-9]*\.[0-9]*\.[0-9]* — synced across all surfaces/$NEW_VERSION — synced across all surfaces/" AGENTS.md
sed -i "s/| \`package.json\` | [0-9]*\.[0-9]*\.[0-9]*/| \`package.json\` | $NEW_VERSION/" AGENTS.md
sed -i "s/| MCP server (\`mcp\/entry.ts\`) | [0-9]*\.[0-9]*\.[0-9]*/| MCP server (\`mcp\/entry.ts\`) | $NEW_VERSION/" AGENTS.md
sed -i "s/| Global npm install | [0-9]*\.[0-9]*\.[0-9]*/| Global npm install | $NEW_VERSION/" AGENTS.md
sed -i "s/| GitHub Release | v[0-9]*\.[0-9]*\.[0-9]*/| GitHub Release | v$NEW_VERSION/" AGENTS.md
sed -i "s/| Git tag | v[0-9]*\.[0-9]*\.[0-9]*/| Git tag | v$NEW_VERSION/" AGENTS.md
sed -i "s/| npm registry | [0-9]*\.[0-9]*\.[0-9]*/| npm registry | $NEW_VERSION/" AGENTS.md

# docs/INSTRUCTION.md
sed -i "s/version: \"[0-9]*\.[0-9]*\.[0-9]*\"/version: \"$NEW_VERSION\"/" docs/INSTRUCTION.md

log "Version synced to: package.json, mcp/entry.ts, AGENTS.md, docs/INSTRUCTION.md"

# Step 5: Build
log "Step 5: Building..."
npm run build || error "Build failed"

# Step 6: Commit and tag
log "Step 6: Committing and tagging..."
git add -A
git commit -m "chore: bump version to $NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Version $NEW_VERSION"

# Step 7: Push to GitHub
log "Step 7: Pushing to GitHub..."
git push origin main --tags

# Step 8: Create GitHub Release with detailed notes from CHANGELOG
log "Step 8: Creating GitHub Release..."

# Extract current version section from CHANGELOG.md for release notes
CHANGELOG_SECTION=$(awk -v ver="$NEW_VERSION" '
  /^## \[/ { if (found) exit; if ($0 ~ ver) { found=1; next } }
  found { print }
' CHANGELOG.md 2>/dev/null)

# Get previous version for diff link
PREV_VERSION=$(grep -oP '\[\K[0-9]+\.[0-9]+\.[0-9]+' CHANGELOG.md | sed -n '2p')
DIFF_LINK=""
if [[ -n "$PREV_VERSION" ]]; then
    DIFF_LINK="**Full Changelog**: https://github.com/gjczone/pi-shazam/compare/v${PREV_VERSION}...v${NEW_VERSION}"
fi

# Build release notes
RELEASE_NOTES="# v$NEW_VERSION

## What's Changed

${CHANGELOG_SECTION}

## Upgrade

\`\`\`bash
pi install npm:pi-shazam@latest
\`\`\`

Or for MCP clients:
\`\`\`json
{ \"mcpServers\": { \"pi-shazam\": { \"command\": \"npx\", \"args\": [\"-y\", \"-p\", \"pi-shazam@${NEW_VERSION}\", \"pi-shazam-mcp\"] } } }
\`\`\`

${DIFF_LINK}"

gh release create "v$NEW_VERSION" \
    --title "v$NEW_VERSION" \
    --notes "$RELEASE_NOTES" \
    --verify-tag

log "GitHub Release created with CHANGELOG content. npm publish will be triggered automatically."

# Step 8.5: Clean up merged remote branches
log "Step 8.5: Cleaning up merged remote branches..."
MERGED_BRANCHES=$(git branch -r --merged origin/main | grep -v "origin/main\|origin/HEAD" | sed 's/  origin\///')
if [[ -n "$MERGED_BRANCHES" ]]; then
    for BRANCH in $MERGED_BRANCHES; do
        log "  Deleting merged remote branch: $BRANCH"
        git push origin --delete "$BRANCH" 2>/dev/null || warn "Failed to delete $BRANCH"
    done
    log "  Remote branches cleaned up."
else
    log "  No merged remote branches to clean up."
fi

# Step 9: Wait for npm publish
log "Step 9: Waiting for npm publish (watching GitHub Actions)..."
sleep 5

# Get the latest workflow run
RUN_ID=$(gh run list --workflow=publish.yml --limit=1 --json databaseId --jq '.[0].databaseId')
if [[ -n "$RUN_ID" ]]; then
    gh run watch "$RUN_ID" || warn "Could not watch workflow. Check manually: gh run list --workflow=publish.yml"
fi

# Step 10: Update local installations
log "Step 10: Updating local installations..."

# Update global npm (use @latest to avoid locking version)
log "Updating global npm..."
npm install -g pi-shazam@latest --legacy-peer-deps 2>&1 | tail -3

# Update Pi extension (use @latest to avoid locking version)
log "Updating Pi extension..."
pi install npm:pi-shazam@latest 2>&1 | tail -5

# Step 11: Verify
log "Step 11: Verifying installations..."

echo ""
echo "=== Verification ==="

# Get installed versions
GLOBAL_VERSION=$(npm ls -g pi-shazam 2>/dev/null | grep pi-shazam | sed 's/.*@//' | sed 's/ .*//')
PI_VERSION=$(cat ~/.pi/agent/npm/node_modules/pi-shazam/package.json 2>/dev/null | grep '"version"' | sed 's/.*"//' | sed 's/".*//')
NPM_VERSION=$(npm view pi-shazam version)

echo "Global npm: v$GLOBAL_VERSION"
echo "Pi extension: v$PI_VERSION"
echo "npm registry: v$NPM_VERSION"

# Verify they match
if [[ "$GLOBAL_VERSION" == "$NEW_VERSION" && "$PI_VERSION" == "$NEW_VERSION" ]]; then
    echo ""
    log "All installations synced to v$NEW_VERSION"
else
    warn "Version mismatch detected! Manual sync may be needed."
    warn "Run: npm install -g pi-shazam@latest --legacy-peer-deps && pi install npm:pi-shazam@latest"
fi

echo ""
log "Release v$NEW_VERSION complete!"
log ""
log "Next steps:"
log "  - Test MCP: pi-shazam-mcp"
log "  - Test Pi: pi -p 'call shazam_overview briefly'"
log "  - Check GitHub: gh release view v$NEW_VERSION"

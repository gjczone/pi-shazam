#!/usr/bin/env bash
set -euo pipefail

echo "==> CI Quick Gate (public): $(date)"
echo "Full verification runs on GitHub Actions."
echo ""

# Step 1: Install dependencies
echo "--- Install dependencies ---"
npm install --legacy-peer-deps
echo "  dependencies installed"
echo ""

# Step 2: Format check
echo "--- Format check ---"
npx prettier --check . 2>/dev/null || { echo "  FAILED -- run npx prettier --write ."; exit 1; }
echo "  prettier check passed"
echo ""

# Step 3: Type check
echo "--- Type check ---"
npm run typecheck
echo "  type check passed"
echo ""

# Step 4: Tests
echo "--- Tests ---"
if ! npm test; then
  echo "  FAILED -- tests must pass before push"
  exit 1
fi
echo "  tests passed"
echo ""

# Step 5: CI config check
echo "--- CI config check ---"
node -e "require('fs').existsSync('.github/workflows/ci.yml')||(console.error('ci.yml missing'),process.exit(1))"
echo "  ci.yml present"
echo ""

echo "==> Quick gate PASSED -- push and let GitHub Actions run full CI"

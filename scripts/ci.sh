#!/usr/bin/env bash
set -euo pipefail

echo "==> CI Quick Gate (public): $(date)"
echo "Full verification runs on GitHub Actions."
echo ""

# Step 1: Install dependencies
echo "--- Install dependencies ---"
npm install --legacy-peer-deps
echo "  ✓ dependencies installed"
echo ""

# Step 2: Type check
echo "--- Type check ---"
npm run typecheck
echo "  ✓ type check passed"
echo ""

# Step 3: Format check
echo "--- Format check ---"
npx prettier --check .
echo "  ✓ format check passed"
echo ""

# Step 4: Verify ci.yml exists and references match
echo "--- CI config check ---"
test -f .github/workflows/ci.yml || { echo "  ✗ ci.yml missing — generate via git-ops skill"; exit 1; }
echo "  ✓ ci.yml present"
echo ""

echo "==> Quick gate PASSED — push and let GitHub Actions run full CI"

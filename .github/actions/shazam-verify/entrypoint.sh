#!/usr/bin/env bash
# entrypoint.sh — Resolve dist, run shazam_verify, compute critical paths
#
# #638: GitHub Action wrapper for shazam_verify
set -euo pipefail

# Resolve project root
PROJECT_ROOT="${INPUT_PROJECT_ROOT:-.}"
if [[ "$PROJECT_ROOT" != /* ]]; then
  PROJECT_ROOT="${GITHUB_WORKSPACE}/${PROJECT_ROOT}"
fi

MAX_FILES="${INPUT_MAX_FILES:-100}"

# Resolve the pi-shazam dist directory.
# Priority: workspace node_modules (external-repo usage) > action repo (this repo)
DIST_DIR=""
if [[ -d "${GITHUB_WORKSPACE}/node_modules/pi-shazam/dist" ]]; then
  DIST_DIR="${GITHUB_WORKSPACE}/node_modules/pi-shazam/dist"
elif [[ -d "${GITHUB_WORKSPACE}/dist" ]]; then
  # Running within the pi-shazam repo itself
  DIST_DIR="${GITHUB_WORKSPACE}/dist"
else
  echo "::error::Cannot find pi-shazam dist directory"
  exit 1
fi

echo "::group::Running shazam_verify"
node "${GITHUB_WORKSPACE}/.github/actions/shazam-verify/run-verify.mjs" \
  "$DIST_DIR" \
  "$PROJECT_ROOT" \
  "$MAX_FILES" \
  > "${RUNNER_TEMP}/shazam-verify-result.json"
echo "::endgroup::"

echo "verify-result-path=${RUNNER_TEMP}/shazam-verify-result.json" >> "$GITHUB_OUTPUT"

#!/usr/bin/env bash
# post-comment.sh — Post PR comment from shazam_verify result
#
# #638: GitHub Action wrapper for shazam_verify
set -euo pipefail

RESULT_PATH="${RUNNER_TEMP}/shazam-verify-result.json"
FAIL_ON_VERDICT="${INPUT_FAIL_ON_VERDICT:-false}"

if [[ ! -f "$RESULT_PATH" ]]; then
  echo "::warning::shazam-verify-result.json not found at $RESULT_PATH"
  exit 0
fi

# Format the comment markdown
COMMENT_MD=$(node "${GITHUB_WORKSPACE}/.github/actions/shazam-verify/post-comment.mjs" "$RESULT_PATH")

# Write comment to a temp file (avoid shell escaping issues with --body-file)
COMMENT_FILE="${RUNNER_TEMP}/shazam-verify-comment.md"
echo "$COMMENT_MD" > "$COMMENT_FILE"

# Write step summary (visible in the Actions run log, not just PR comment)
echo "$COMMENT_MD" >> "$GITHUB_STEP_SUMMARY"

# Post PR comment if this is a PR context
if [[ -n "${GITHUB_EVENT_PULL_REQUEST_NUMBER:-}" ]]; then
  gh pr comment "${GITHUB_EVENT_PULL_REQUEST_NUMBER}" --body-file "$COMMENT_FILE" --repo "${GITHUB_REPOSITORY}"
fi

# Exit with non-zero if fail-on-verdict is true and verdict is FAIL
VERDICT=$(node -e "const r=require('$RESULT_PATH'); process.stdout.write(r.result.verdict)")
if [[ "$FAIL_ON_VERDICT" == "true" && "$VERDICT" == "FAIL" ]]; then
  echo "::error::shazam_verify verdict: FAIL (fail-on-verdict=true)"
  exit 1
fi

echo "shazam_verify verdict: $VERDICT"

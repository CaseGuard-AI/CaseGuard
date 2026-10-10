#!/usr/bin/env bash
# Applies the repository settings and branch protection described in
# docs/engineering/branching-and-release.md. Idempotent: safe to re-run.
#
# Requirements: GitHub CLI authenticated as a repo admin (`gh auth login`).
# Usage:        scripts/setup-branch-protection.sh [owner/repo]
#               REQUIRE_CODEOWNERS=true scripts/setup-branch-protection.sh   # once CODEOWNERS is filled in
set -euo pipefail

REPO="${1:-CaseGuard-AI/CaseGuard}"
REQUIRE_CODEOWNERS="${REQUIRE_CODEOWNERS:-false}"
APPROVALS="${APPROVALS:-1}"

command -v gh >/dev/null || { echo "gh CLI not found"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login"; exit 1; }

echo "→ Ensuring 'staging' exists on $REPO"
if ! gh api "repos/$REPO/branches/staging" >/dev/null 2>&1; then
  MAIN_SHA=$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)
  gh api -X POST "repos/$REPO/git/refs" -f ref=refs/heads/staging -f sha="$MAIN_SHA" >/dev/null
  echo "  created staging from main@$MAIN_SHA"
fi

echo "→ Repository settings (default branch, merge methods, auto-delete)"
gh api -X PATCH "repos/$REPO" \
  -f default_branch=staging \
  -F allow_squash_merge=true \
  -F allow_merge_commit=true \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY >/dev/null

echo "→ Security features"
gh api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null 2>&1 || echo "  (vulnerability alerts: enable manually if this failed)"
gh api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null 2>&1 || true
gh api -X PATCH "repos/$REPO" --input - >/dev/null 2>&1 <<'JSON' || echo "  (secret scanning: enable manually in Settings → Code security)"
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON

protect() {
  local branch="$1" strict="$2"
  echo "→ Protecting $branch"
  gh api -X PUT "repos/$REPO/branches/$branch/protection" --input - >/dev/null <<JSON
{
  "required_status_checks": {
    "strict": $strict,
    "contexts": ["ci-ok", "Conventional PR title", "Branch naming and target", "TruffleHog (verified secrets)"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": $APPROVALS,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": $REQUIRE_CODEOWNERS
  },
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
JSON
}

# staging: must be up to date before merge (strict); main: release PRs from staging.
protect staging true
protect main false

echo "✓ Done. Verify at https://github.com/$REPO/settings/branches"

#!/usr/bin/env bash
#
# Run the Haiku/Sonnet issue sweep sequentially on main.
# Each task writes to its own log file; review locally before opening PRs.
#
# Usage:  ./scripts/parallel-sweep.sh
# Tail a single task:  tail -f /tmp/swangin-sweep/7.log

set -euo pipefail

REPO_ROOT="$HOME/Code/swangin"
LOG_ROOT="/tmp/swangin-sweep"
mkdir -p "$LOG_ROOT"

# Format: ISSUE:MODEL:SLUG
TASKS=(
  "17:haiku:ts-version"
  "8:haiku:colyseus-url"
  "7:sonnet:peer-pose-buffer"
  "10:sonnet:grapple-thrash"
  "14:sonnet:died-dedup"
  "18:sonnet:constants-consolidation"
  "11:sonnet:anchor-staleness"
  "16:sonnet:dead-code-purge"
)

cd "$REPO_ROOT"
echo "Fetching origin/main..."
git fetch origin main --quiet

run_task() {
  local issue="$1" model="$2" slug="$3"
  local log="${LOG_ROOT}/${issue}.log"

  # Pull issue body so the agent doesn't have to look it up
  local body
  body=$(gh issue view "$issue" --json title,body \
    -q '"# Issue #'"$issue"': " + .title + "\n\n" + .body')

  # Headless prompt
  local prompt
  prompt=$(cat <<PROMPT
You are implementing the following GitHub issue end-to-end.

${body}

Rules:
1. Make the minimum changes needed. Do not refactor adjacent code, do not "improve" things outside the issue scope.
2. After your edits, run \`npm run build\` from the relevant package (client/ or server/) to confirm it typechecks.
3. Stage your changes and create one commit. The commit message should reference the issue, e.g. "fix(grapple): skip joint recreate below epsilon (#${issue})".
4. Do NOT push and do NOT open a PR. The human will review locally first.
5. If you hit a blocker that requires a design decision, STOP, do not commit, and output a short summary.
6. When done, print a one-paragraph summary of what you changed.
PROMPT
)

  echo "[#$issue] launching claude (log=$log)..."
  claude -p "$prompt" \
    --model "$model" \
    --dangerously-skip-permissions \
    >>"$log" 2>&1
  echo "[#$issue] DONE (exit=$?)" >>"$log"
  echo "[#$issue] complete"
}

for t in "${TASKS[@]}"; do
  IFS=':' read -r issue model slug <<<"$t"
  run_task "$issue" "$model" "$slug"
done

echo
echo "=== All ${#TASKS[@]} tasks complete ==="

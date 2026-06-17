#!/bin/bash
set -e

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <iterations> <github-issue-url>"
  exit 1
fi

ISSUE_URL="$2"

for ((i=1; i<=$1; i++)); do
  result=$(claude --permission-mode acceptEdits -p "@PLAN.md $ISSUE_URL \
  1. For this github issue, find the highest-priority task and implement it. \
  2. Run your tests and type checks. \
  3. Append your progress to progress.txt. \
  4. Commit your changes. \
  ONLY WORK ON A SINGLE TASK. \
  If the issue is complete, output <promise>STOP</promise>.
  If you are blocked and cannot unblock yourself, print the issue, update progress.txt and then finally output <promise>STOP</promise>.")

  echo "$result"

  if [[ "$result" == *"<promise>STOP</promise>"* ]]; then
    echo "Stopping after $i iterations."
    exit 0
  fi
done

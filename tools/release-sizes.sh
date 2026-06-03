#!/bin/sh
# Print dmg sizes for every pk-v* release on Moorhen-PyKeko (canonical).
# Output formatted as a markdown row ready to paste into RELEASE-HISTORY.md.
#
# Usage:
#   tools/release-sizes.sh
#       — print all releases as one table
#   tools/release-sizes.sh v0.2.9
#       — print only the named version's row
#
# Reads from the GitHub API via `gh`; needs `gh auth status` to be OK.

set -e
REPO=${REPO:-pykeko/Moorhen-PyKeko}
ONLY=${1:-}

list_tags() {
  if [ -n "$ONLY" ]; then
    echo "pk-$ONLY"
  else
    gh release list --repo "$REPO" --limit 50 --json tagName --jq '.[].tagName' \
      | grep -E '^pk-v' | sort -V
  fi
}

# Headers (only when printing the full table)
if [ -z "$ONLY" ]; then
  printf '| Version | Date | dmg size | Δ prior | Δ vs v0.1 | Headline |\n'
  printf '|---|---|---:|---:|---:|---|\n'
fi

PREV_BYTES=
FIRST_BYTES=
for TAG in $(list_tags); do
  ROW=$(gh api "repos/$REPO/releases/tags/$TAG" 2>/dev/null | python3 -c '
import sys, json
r = json.load(sys.stdin)
date = (r.get("published_at") or "")[:10]
for a in r.get("assets", []):
    if a["name"].endswith(".dmg"):
        size = a["size"]
        mb = size / (1024 * 1024)
        print(f"{date}|{size}|{mb:.2f}")
        break
')
  [ -z "$ROW" ] && continue
  DATE=$(echo "$ROW" | cut -d'|' -f1)
  BYTES=$(echo "$ROW" | cut -d'|' -f2)
  MB=$(echo "$ROW" | cut -d'|' -f3)
  [ -z "$FIRST_BYTES" ] && FIRST_BYTES=$BYTES
  if [ -n "$PREV_BYTES" ]; then
    DELTA_PREV=$(python3 -c "print(f'{(${BYTES} - ${PREV_BYTES}) / (1024*1024):+.2f}')")
    DELTA_FIRST=$(python3 -c "print(f'{(${BYTES} - ${FIRST_BYTES}) / (1024*1024):+.2f}')")
  else
    DELTA_PREV="—"
    DELTA_FIRST="—"
  fi
  PREV_BYTES=$BYTES
  printf '| %-9s | %s | %7s MB | %7s | %7s | _add headline here_ |\n' "$TAG" "$DATE" "$MB" "$DELTA_PREV" "$DELTA_FIRST"
done

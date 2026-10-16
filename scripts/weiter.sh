#!/usr/bin/env bash
# Kette fortsetzen: naechstes Glied per Dispatch starten und BELEGEN, dass es
# wirklich wartet (Masterplan 16.10.2026, W2, Review D13).
#
# Frueher: `gh workflow run watchdog.yml || true` — ohne Repo-Angabe, ohne
# Checkout. Das scheiterte bei JEDEM Lauf mit "not a git repository", und das
# `|| true` verschluckte es. Die Kette hat sich nie selbst verlaengert.
#
# Umgebung: GITHUB_REPOSITORY GITHUB_RUN_ID ZUSTAND  (GH_TOKEN fuer gh)
#           WARTE_SEK (Default 10), VERSUCHE (Default 3)
set -u -o pipefail
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY fehlt}"
eigen="${GITHUB_RUN_ID:?GITHUB_RUN_ID fehlt}"
warte="${WARTE_SEK:-10}"
versuche="${VERSUCHE:-3}"

z="${ZUSTAND:-}"; [ -n "$z" ] || z='{}'
# 60 s Uhrentoleranz (Runner-Uhr vs. GitHub createdAt). Portabel ueber jq statt GNU-date.
ab=$(jq -nr 'now - 60 | floor | todate')
ok=0
for i in $(seq 1 "$versuche"); do
  if gh workflow run watchdog.yml -R "$repo" --ref main -f zustand="$z"; then ok=1; break; fi
  echo "Dispatch-Versuch $i fehlgeschlagen"; sleep $(( warte * 2 ))
done
[ "$ok" = 1 ] || { echo "::error::Dispatch nach $versuche Versuchen gescheitert — Kette reisst"; exit 1; }

# Ein FREMDER Lauf (nicht dieser), ausgeloest per Dispatch nach unserer Zeit,
# muss aktiv oder wartend sein. Der eigene Lauf ist in_progress und beweist nichts.
for i in 1 2 3 4 5 6; do
  sleep "$warte"
  treffer=$(gh run list -R "$repo" --workflow watchdog.yml --limit 10 \
      --json databaseId,event,status,createdAt \
    | jq --arg eigen "$eigen" --arg ab "$ab" '[.[]
        | select((.databaseId|tostring) != $eigen)
        | select(.event == "workflow_dispatch")
        | select(.createdAt >= $ab)
        | select(.status as $s | ["queued","pending","waiting","requested","in_progress"] | index($s))
      ] | length')
  if [ "${treffer:-0}" -ge 1 ]; then echo "Folgeglied wartet (seit $ab)."; exit 0; fi
done
echo "::error::Dispatch angenommen, aber kein Folgeglied sichtbar — Kette reisst"
exit 1

#!/usr/bin/env bash
# Heiler (Masterplan 16.10.2026, W3): startet die Kette nur, wenn KEIN Glied
# laeuft oder wartet. Zweimal pruefen (60 s Abstand), weil zwischen Ende des
# alten und Start des neuen Glieds kurz keins sichtbar ist (Review H14) —
# ein Dispatch genau dann wuerde das Glied mit Zustand verdraengen.
#
# Ehrlich: Auch dieser Schedule kommt bei GitHub oft nur alle paar Stunden.
# Er ist Rueckfall, nicht Taktgeber. Einen Riss MELDET der Totmannschalter.
#
# Umgebung: GITHUB_REPOSITORY (GH_TOKEN fuer gh), PAUSE_SEK (Default 60)
set -u -o pipefail
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY fehlt}"
# Nur ein ERFOLGREICH gelesenes 0 darf heilen. Faellt die API aus (5xx, Rate-Limit,
# Token), wird NICHT gestartet: ein Dispatch koennte sonst das wartende Glied mit
# Zustand verdraengen (Review D20). Lieber eine Runde nicht heilen.
aktiv() {
  local roh
  roh=$(gh run list -R "$repo" --workflow watchdog.yml --limit 10 --json status) || return 1
  printf '%s' "$roh" \
    | jq -e '[.[] | select(.status as $s | ["queued","pending","waiting","requested","in_progress"] | index($s))] | length' \
    || return 1
}
pruefe() {
  if ! a=$(aktiv) || ! [ "$a" -ge 0 ] 2>/dev/null; then
    echo "::warning::Kettenstatus nicht lesbar — kein Neustart in dieser Runde"; exit 0
  fi
  [ "$a" -ge 1 ] && { echo "Kette laeuft ($a aktiv/wartend$1)."; exit 0; }
}
pruefe ""
sleep "${PAUSE_SEK:-60}"
pruefe ", zweite Pruefung"
echo "::warning::Keine Kette aktiv — Heiler startet neu (Zustand leer)"
gh workflow run watchdog.yml -R "$repo" --ref main -f zustand='{}'

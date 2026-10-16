#!/usr/bin/env bash
# Ein Kettenglied des Watchdog-Takts (Masterplan 16.10.2026, Paket W).
#
# Pingt alle TAKT_SEK Sekunden den Endpoint fuer jede Organisation in ORGS und
# fuehrt den Entprellzustand je Organisation (prev, alertedFp, lastAlert) mit.
# Der Zustand kommt als JSON aus ZUSTAND (vom vorigen Glied) und geht am Ende
# als JSON nach ZUSTAND_AUS — damit faengt das naechste Glied NICHT wieder bei
# "OK" an (sonst: laufender Alarm wird neu gemeldet, Entwarnung geht verloren).
#
# Totmannschalter (healthchecks.io): Antwortet der Endpoint, geht ein Erfolgs-
# Ping raus — ueberwacht wird der Waechter, nicht das System. Bleibt der
# Endpoint ZWEI Runden in Folge stumm, geht ein /fail-Ping raus ("Waechter
# blind"). Ein einzelner Aussetzer meldet nichts (Flughoehen-Regel).
# Bei mehreren Organisationen in ORGS gilt: Antwortet IRGENDEINE, ist der Waechter
# "up" — der Ausfall einer einzelnen Organisation zeigt sich im Log (CURL_FAIL),
# nicht im Totmannschalter. Heute ist ORGS nur tattoo-fashion.
#
# Umgebung:
#   BASE KEY ORGS ZUSTAND ZUSTAND_AUS DAUER_SEK TAKT_SEK HC_UUID(optional)
#   HC_BASE (Default https://hc-ping.com)   — fuer Tests ueberschreibbar
set -u

BASE="${BASE:-https://tf-watchdog.vercel.app/api/check}"
ORGS="${ORGS:-tattoo-fashion}"
DAUER_SEK="${DAUER_SEK:-20400}"
TAKT_SEK="${TAKT_SEK:-300}"
HC_BASE="${HC_BASE:-https://hc-ping.com}"
ZUSTAND_AUS="${ZUSTAND_AUS:-/dev/null}"

# Eingangszustand pruefen: kaputtes oder leeres JSON -> leerer Zustand ("OK").
zustand="${ZUSTAND:-}"
if [ -z "$zustand" ] || ! printf '%s' "$zustand" | jq -e 'type == "object"' >/dev/null 2>&1; then
  [ -n "$zustand" ] && echo "::warning::Zustand vom Vorgaenger unlesbar, Start bei OK"
  zustand='{}'
fi

# Sofort festhalten: bricht das Skript vor der ersten Runde ab, bekommt das
# Folgeglied trotzdem den uebernommenen Zustand statt {} (Review H-W2).
printf '%s' "$zustand" > "$ZUSTAND_AUS"

if [ -z "${HC_UUID:-}" ]; then
  echo "::warning::HC_UUID fehlt, Totmannschalter aus"
fi

hc() { # $1 = "" fuer Erfolg, "/fail" fuer blind
  [ -n "${HC_UUID:-}" ] || return 0
  curl -fsS -m 10 --retry 2 "${HC_BASE}/${HC_UUID}$1" >/dev/null 2>&1 \
    || echo "$(date -u +%H:%M:%S) hc-ping$1 fehlgeschlagen"
}

ende=$(( $(date +%s) + DAUER_SEK ))
blind=0
n=0
while :; do
  n=$((n+1))
  antwort=0
  for org in $ORGS; do
    now=$(date +%s)
    prev=$(printf '%s' "$zustand" | jq -r --arg o "$org" '.[$o].prev // "OK"')
    afp=$(printf '%s' "$zustand" | jq -r --arg o "$org" '.[$o].alertedFp // "OK"')
    last=$(printf '%s' "$zustand" | jq -r --arg o "$org" '(.[$o].lastAlert // 0) | tonumber? // 0')
    resp=$(curl -fsS -m 25 --get "$BASE" \
      --data-urlencode "org=${org}" \
      --data-urlencode "key=${KEY:-}" \
      --data-urlencode "prev=${prev}" \
      --data-urlencode "alertedFp=${afp}" \
      --data-urlencode "sinceAlert=$(( now - last ))")
    if [ $? -ne 0 ] || [ -z "$resp" ] || ! printf '%s' "$resp" | jq -e . >/dev/null 2>&1; then
      echo "$(date -u +%H:%M:%S) ping#$n $org -> CURL_FAIL"
      continue
    fi
    antwort=1
    fp=$(printf '%s' "$resp" | jq -r '.fp // "OK"')
    hat=$(printf '%s' "$resp" | jq -r '(.alerted.problem // false)')
    weg=$(printf '%s' "$resp" | jq -r '(.alerted.resolved // false)')
    [ "$hat" = "true" ] && { last=$now; afp="$fp"; }
    [ "$weg" = "true" ] && afp="OK"
    zustand=$(printf '%s' "$zustand" | jq -c --arg o "$org" --arg p "$fp" --arg a "$afp" --argjson l "$last" \
      '.[$o] = {prev: $p, alertedFp: $a, lastAlert: $l}')
    echo "$(date -u +%H:%M:%S) ping#$n $org -> fp=${fp} alert=${hat} gemeldet=${afp}"
  done

  if [ "$antwort" = 1 ]; then
    blind=0; hc ""
  else
    blind=$((blind+1))
    [ "$blind" -ge 2 ] && hc "/fail"
  fi

  printf '%s' "$zustand" > "$ZUSTAND_AUS"
  [ $(( $(date +%s) + TAKT_SEK )) -lt "$ende" ] || break
  sleep "$TAKT_SEK"
done
echo "Glied fertig nach $n Runden. Zustand: $zustand"

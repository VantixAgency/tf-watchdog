# Monitoring-Konfiguration je Installation (G4)

Der Watchdog trug vier Workflow-IDs, einen Match-String, feste Alarmempfaenger und einen
Anbieternamen fest im Code. Ein zweiter Mandant waere damit **unueberwacht** geblieben —
bei einem System, dessen Kernversprechen "kein Lead geht verloren" lautet.

Jetzt kommt alles aus `installationen.json`, validiert gegen `schema.mjs`.

## Regeln

- **Keine Secrets in dieser Datei.** `secretRefs` nennt ausschliesslich NAMEN von
  Umgebungsvariablen. Ein Wert statt eines Namens wird von der Validierung abgelehnt.
- **Keine freien Regex, keine Ausdruecke.** Nur typisierte Werte aus erlaubten Listen.
- **Eine Workflow-ID gehoert hoechstens einer Organisation.** Doppelte Zuordnung wird
  abgelehnt — sonst waere ein Cross-Tenant-Alarm moeglich.
- **Ungueltige Konfiguration ist ein harter Fehler.** Der Endpunkt antwortet mit 500,
  statt still weiterzulaufen. Ein Melder, der nichts prueft, ist schlimmer als keiner.
- **Ohne konfigurierten `provider.webhookMatch` wird nicht geraten.** Der Check meldet
  `skipped`, nicht `ok` — sonst behauptete er Gesundheit, die er nie geprueft hat.

## Felder je Organisation

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `id` | ja | klein, alphanumerisch, 2–39 Zeichen, eindeutig |
| `anzeigename` | ja | Klartext fuer Alarme |
| `n8nUrl` | nein | https-URL der Instanz; sonst Fallback `N8N_URL` |
| `kritischeWorkflows` | ja | `{id, bezeichnung}` — leer ist verboten |
| `pruefungen` | ja | Auswahl aus `PRUEFUNGEN` |
| `provider.webhookMatch` | fuer `provider_webhook` | organisationseigener Match |
| `kanaele` | fuer `kanal_wirkung` | Liste aus `instagram`/`whatsapp`; wird NICHT geraten |
| `kanaeleAusDb` | nein | `true`: Kanaele je Account = aktive `account_channels`-Zeilen ∪ Kanaele aus `kanaele`, auf denen je eine Kundennachricht einging (ohne Zeitgrenze); Ingestion prueft alle Accounts, Kanal-Wirkung nur `ki_global_on=true`; Marke/Standort im Alarmtext. Unbekannter Kanalwert und nicht lesbare Kanalquelle werden als `KANALQUELLE:`-Problem gemeldet. Ohne Schalter Verhalten wie vorher |
| `nichtUeberwachen` | nein | Slug-Liste (Vorfuehr-/Probe-Studios), von Ingestion und Kanal-Wirkung ausgenommen. Default leer |
| `markePflicht` | nein | `true`: scheitert der Embed `mandant:mandanten(marke)`, ist das ein Problem (`Marke nicht lesbar (HTTP x)`). Default und TF vorerst `false` |
| `alarm.email` / `alarm.telegramChatIds` | mindestens eines | Empfaenger |
| `alarm.betreffProblem` / `betreffOk` / `absender` | nein | sonst neutrale Vorgabe |
| `schwellen.*` | nein | innerhalb `GRENZEN`, sonst abgelehnt |
| `secretRefs.*` | nein | Variablennamen, nie Werte |

## Runbook: Mandantenumbau (Plan 2026-10-16, Task 8)

- **Fingerprint wechselt beim Deploy.** Mit `kanaeleAusDb` kommen die Bausteine
  `ingk:<slug>/<kanal>:ingestion_tot` und `kq:<problemzeilen>` dazu. Steht beim Deploy
  ein Ingestion-Alarm oder ein Kanalquellen-Problem an, gilt das als neuer Zustand:
  nach der Zweifach-Bestaetigung kommt **eine** erneute Alarm-Mail. Ohne anstehendes
  Problem aendert sich nichts (`OK` bleibt `OK`).
- **`markePflicht` erst nach 0028.** Bis Migration 0028 live ist, scheitert der Embed
  auf `mandanten` (HTTP 400) und der Melder prueft ohne Marke weiter. Nach 0028 und dem
  Probe-GET des Embeds `markePflicht: true` setzen, dann ist eine fehlende Marke laut.
- **PFLICHT vor dem Aktivieren des Schalters (nur lesend):** den Bestand pruefen:
  1. alle `platform`-Werte aktiver Zeilen: `select distinct platform from account_channels where active`.
     Jeder Wert ausser `instagram`/`whatsapp` (nach trim/klein) erzeugt bei jedem Lauf
     „Kanal unbekannt“ und damit einen Daueralarm. Erst bereinigen, dann einschalten.
  2. ob TF je Account aktive Zeilen fuer Instagram und WhatsApp hat. Fehlen sie, haelt
     nur „je Verkehr gehabt“ den Kanal in der Ueberwachung (`kanalAusVerkehr` zeigt das).
  3. welche Studios Vorfuehr-/Probe-Studios sind: deren Slug in `nichtUeberwachen`.
- **ki_global_on:** Die Ingestion prueft alle Accounts (der Eingang haengt nicht an der
  KI). Nur die Kanal-Wirkung laesst Accounts mit `ki_global_on=false` aus.

## Warum `kanal_wirkung` seit dem 17.09.2026 dabei ist

Andy meldete, auf WhatsApp Muenchen gehe "gar nichts". Der Watchdog hatte in den
30 Stunden davor **272-mal geprueft und 272-mal OK gemeldet**. Der Ausfall war real:
zwischen 10 und 14 Uhr kamen 17 Kundennachrichten an, die KI beantwortete davon
keine, das Team fing 11 von Hand ab.

Der Melder war nicht kaputt, er hat die falschen Fragen gestellt:

- **`ingestion`** fragte "kam irgendwo die letzte Nachricht an?" — ohne Kanal- und
  ohne Studiofilter. Eine Instagram-Nachricht aus Landshut hielt ihn gruen.
  Seit dem 17.09. fragt er je Studio **und** Kanal.
- **`antwort_stau`** filtert `ai_paused=eq.false`. Ein Chat, den die Uebernahme
  pausiert hat, verschwindet damit aus der Ueberwachung. Ein Kanal, in dem alle
  Chats pausiert sind, ist fuer ihn maximal gesund. Derselbe Filter steckt im
  internen n8n-Melder.
- **`workflow_fehler`** gab bei jedem Nicht-200 `ok: true` zurueck, auch bei 401.
  Ein abgelaufener n8n-Schluessel machte ihn still blind. Er meldet das jetzt.

Keiner der Melder verglich, **wie viel reinkam gegen wie viel beantwortet wurde**.
Genau das tut `kanal_wirkung`, je Studio und Kanal getrennt. Begruendung der
Schwellen und die Testfaelle stehen in `api/kanal-wirkung.mjs` und
`test/kanal-wirkung*.test.js` — die Fixtures dort sind die echten Messwerte des
Vorfalls, nicht ausgedachte Zahlen.

## Aufruf

`GET /api/check` prueft die erste Organisation, `GET /api/check?org=<id>` eine bestimmte.
Getrennte Laeufe statt Sammellauf: So kann ein Alarm der einen Organisation die andere
weder verzoegern noch faelschlich betreffen.

## Eine zweite Installation anlegen

Einen Eintrag in `organisationen` ergaenzen, eigene Umgebungsvariablen setzen, fertig.
Kein Code-Fork. Der Duplikationstest in `test/duplikation.test.js` beweist das mit einer
synthetischen zweiten Organisation.

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
| `alarm.email` / `alarm.telegramChatIds` | mindestens eines | Empfaenger |
| `alarm.betreffProblem` / `betreffOk` / `absender` | nein | sonst neutrale Vorgabe |
| `schwellen.*` | nein | innerhalb `GRENZEN`, sonst abgelehnt |
| `secretRefs.*` | nein | Variablennamen, nie Werte |

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

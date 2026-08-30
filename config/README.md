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
| `alarm.email` / `alarm.telegramChatIds` | mindestens eines | Empfaenger |
| `alarm.betreffProblem` / `betreffOk` / `absender` | nein | sonst neutrale Vorgabe |
| `schwellen.*` | nein | innerhalb `GRENZEN`, sonst abgelehnt |
| `secretRefs.*` | nein | Variablennamen, nie Werte |

## Aufruf

`GET /api/check` prueft die erste Organisation, `GET /api/check?org=<id>` eine bestimmte.
Getrennte Laeufe statt Sammellauf: So kann ein Alarm der einen Organisation die andere
weder verzoegern noch faelschlich betreffen.

## Eine zweite Installation anlegen

Einen Eintrag in `organisationen` ergaenzen, eigene Umgebungsvariablen setzen, fertig.
Kein Code-Fork. Der Duplikationstest in `test/duplikation.test.js` beweist das mit einer
synthetischen zweiten Organisation.

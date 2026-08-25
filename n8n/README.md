# Logik der internen n8n-Melder

Der externe Watchdog (`api/check.js`) läuft auf Vercel, off der überwachten Infra.
Daneben laufen zwei Melder **in** n8n auf dem TF-Server:

| Workflow | Takt | Meldet |
|---|---|---|
| `jmKYSADWCfHFQyqr` — Health-Monitor | 3 Min | Unbeantwortete DMs, Verarbeitungsfehler, KI-Aus-Eskalation |
| `aN9yDA7rqNUWeTDX` — Self-Heal | 5 Min | Zernio nicht verbunden; repariert active_hours-Drift selbst |

## Warum hier Code liegt, der in n8n läuft

n8n-Code-Nodes können nichts importieren. Die Alarm-Entscheidung lebt dort also als
Kopie. Eine Kopie, die niemand prüft, läuft irgendwann auseinander — dann testet man
das eine und betreibt das andere.

Deshalb:

- `alarm-flughoehe.js` — die Entscheidungslogik als reine Funktion. **Quelle der Wahrheit.**
  Getestet in `../test/alarm-flughoehe.test.js`.
- `health-check.live.js` — Snapshot des Node-Codes, wie er in n8n wirklich steht.
- `../test/node-paritaet.test.js` — schneidet die Funktionen aus dem Snapshot heraus und
  lässt sie gegen das Modul antreten. Weicht die Produktion ab, wird der Test rot.
- `../test/health-check-e2e.test.js` — führt den **kompletten** Node-Code gegen eine
  nachgebaute Supabase-REST-Schnittstelle aus (inklusive der serverseitigen Zeitfilter)
  und prüft, was am Ende bei `send` herauskommt. Das ist der Wert, an dem der
  „Alert?"-Node Telegram und Mail aufhängt.

## Wenn du die Schwellen änderst

1. `alarm-flughoehe.js` ändern, `npm test` grün bekommen.
2. Denselben Stand in den n8n-Node „Health Check" übertragen (`PUT /api/v1/workflows/…`).
3. Snapshot neu ziehen nach `health-check.live.js`.
4. `npm test` — der Paritätstest bestätigt, dass beide Seiten gleich urteilen.

Vorher ein Backup ziehen; die letzten liegen in `../n8n-backup/`.

## Die Schwellen und warum sie so stehen

Stand 25.08.2026 (Promise: „ich will keine Meldungen mehr von Nicht-Ausfällen"):

- **3 Chats gleichzeitig** hängend = Stau. Ein einzelner wartender Chat ist Alltag:
  Studio-Übernahme, Message-Request eines Nicht-Followers, Kunde schreibt in Bursts.
- **60 Min** einzeln = Liegenbleiber. Da geht wirklich ein Lead verloren.
- **3 Verarbeitungsfehler** in 15 Min = Häufung. Einzelne heilen sich meist selbst
  (gemessen 13.06.–13.07.: 61 von 84).
- **Zwei Läufe hintereinander** (6 Min), bevor gemeldet wird. Was binnen eines Takts
  weggeht, hat nie jemanden gestört.
- Unbekannte Problemklassen bleiben **immer** meldepflichtig — einen neuen Fehlertyp
  still zu schlucken wäre genau das Blindloch, das ein Watchdog nie haben darf.

## ⚠️ Ladefenster und Schwelle hängen zusammen

Der Node lädt Nachrichten nur aus einem Zeitfenster (`ANSWER_FLOOR`, aktuell **90 Min**).
Eine Kundennachricht, die älter ist, kommt in der Abfrage gar nicht mehr vor — der Chat
kann dann nicht mehr als hängend erkannt werden.

Beim Umbau am 25.08.2026 stand das Fenster noch auf 30 Min, während die neue
Liegenbleiber-Regel bei 60 Min greifen sollte. Die Regel wäre also **nie** angesprungen:
Einzelfall-Meldungen abgeschaltet, Ersatzregel tot. Aufgefallen ist das nur, weil
`test/health-check-e2e.test.js` den echten Node-Code gegen eine nachgebaute Datenbank
laufen lässt — die Unit-Tests der Entscheidungsfunktion konnten es nicht sehen, weil sie
die Datenbeschaffung gar nicht kennen.

**Regel: `ANSWER_FLOOR` muss immer größer sein als `FLUGHOEHE.dmHardMin`.**
Ein Test prüft das; wer eine der beiden Zahlen ändert, wird an die andere erinnert.

# Ingestion-Check: Fehlalarme abstellen (Aktivstunden statt Wanduhr)

Stand 2026-08-11

## Problem

`checkIngestion` meldet „INGESTION TOT", sobald die jüngste eingehende DM älter als
`INGEST_STALE_HOURS` (12) ist — gemessen in Wanduhr-Zeit. Die Uhr läuft aber auch
nachts, wo naturgemäß niemand schreibt. Der Check kann „gerade schreibt keiner"
nicht von „Pipeline tot" unterscheiden.

Zwei belegte Fehlalarme (aus den GitHub-Action-Logs rekonstruiert, Zeiten Berlin):

| Alarm            | letzte DM davor | nächste DM  | Wanduhr-Lücke |
| ---------------- | --------------- | ----------- | ------------- |
| Fr 07.08. 10:46  | Do 22:46        | Fr 12:21    | 13,6 h        |
| Sa 08.08. 05:29  | Fr 17:29        | Sa 09:45    | 16,3 h        |

Beides sind normale Nächte. n8n war oben, keine Workflow-Fehler, kein Reply-Gap.
Beide Alarme gingen von selbst weg, sobald die erste DM des Tages eintraf.

Der Schaden ist nicht die Mail, sondern die Abstumpfung: genau dieser Check ist das
Netz gegen den stillen 13-Tage-Ausfall vom Juni. Ein Melder, dem man nicht mehr
glaubt, ist kein Melder.

## Nicht das Problem

Der Reply-Gap-Check (DM rein, keine Antwort → Alarm nach 25 Min) war im Juli
bereits entschärft und bleibt unverändert **rund um die Uhr** aktiv. Die KI selbst
läuft weiter 24/7. Diese Änderung betrifft ausschließlich die Frage, ab wann
*Stille* als verdächtig gilt.

## Lösung

Stille nur in den Stunden zählen, in denen überhaupt DMs eintrudeln.

- Aktivfenster: **09:00–23:00 Europe/Berlin** (`INGEST_ACTIVE_FROM` / `INGEST_ACTIVE_TO`)
- Alarm ab **12 Aktivstunden** Stille (`INGEST_ACTIVE_STALE_H`)
- Reißleine: **48 h** Wanduhr, unabhängig vom Fenster (`INGEST_HARD_STALE_H`)

`dead = activeHours > INGEST_ACTIVE_STALE_H || ageHours > INGEST_HARD_STALE_H`

Die Reißleine deckt den Fall ab, dass die Fenster-Annahme irgendwann nicht mehr
stimmt. Sie ist bewusst hoch: die längste beobachtete natürliche Lücke war 16,3 h,
und ein toter Sonntag könnte länger sein.

### Erwartetes Verhalten

- Vorfall 1 zum Alarmzeitpunkt: ~3,5 Aktivstunden → kein Alarm
- Vorfall 2 zum Alarmzeitpunkt: ~5,5 Aktivstunden → kein Alarm
- Echter Ausfall: 14 Aktivstunden pro Tag → Alarm binnen rund eines Tages
- Juni-Szenario (13 Tage): Alarm an Tag 1, nicht an Tag 13

### Neue Funktion

`activeHoursBetween(fromMs, toMs, {fromHour, toHour, stepMin, capH})` — rein,
exportiert, testbar. Schrittweise Zählung in 15-Min-Schritten, Berliner Stunde je
Schritt über `Intl.DateTimeFormat` mit `timeZone: "Europe/Berlin"`. Damit ist die
Sommer-/Winterzeit-Umstellung automatisch korrekt, ohne Datumsarithmetik von Hand.
Der Scan wird auf `capH` begrenzt; darüber hinaus entscheidet ohnehin die Reißleine.

### Sichtbarkeit

Die Antwort des Endpoints führt die Zahlen künftig mit, damit ein Alarm ohne
DB-Zugang beurteilbar ist:
`{lastInbound, ageHours, activeHours, activeWindow, activeThresholdH, hardThresholdH, dead, reason}`

Der Fingerprint (`computeFingerprint`) und die Alarm-Entprellung bleiben unberührt.

## Tests

Das Repo hatte bisher keine. Neu: `test/ingestion.test.js` mit `node:test`
(eingebaut, keine Dependency). Abgedeckt:

1. Vorfall 1 zum Alarmzeitpunkt → unter der Schwelle
2. Vorfall 2 zum Alarmzeitpunkt → unter der Schwelle
3. reine Nachtstrecke (23:00 → 08:00) → ~0 Aktivstunden
4. voller Tag Stille (09:00 → 09:00 Folgetag) → 14 h, über der Schwelle
5. Zeitumstellung Ende Oktober → korrekt, kein Absturz
6. Randfälle: `to <= from` → 0; Scan-Deckel greift

## Risiko

Bleibt: die Annahme „zwischen 23 und 9 Uhr schreibt niemand" ist geschätzt, nicht
gemessen — der Supabase-service_role-Key liegt bei Dimi/Luca, Vercel gibt ihn nur
geschwärzt heraus. Ist die Annahme falsch, verzögert sie die Erkennung eines echten
Ausfalls um bis zu ~10 h; die 48-h-Reißleine begrenzt den Schaden. Mit dem Key wäre
später eine selbstlernende Schwelle aus echter Historie möglich (Variante B).

---

## Nachtrag, selben Tag: die Aktivstunden sind wieder raus

Wenige Stunden nach diesem Entwurf kam `checkZernio()` dazu — der Webhook-Status wird
direkt bei Zernio abgefragt. Damit war die oben beschriebene Mechanik überflüssig:

Der Aktivstunden-Ansatz war ein **Rückschluss aus Stille** und brauchte deshalb eine
Annahme darüber, wann Kunden schreiben (09–23 Uhr). Diese Annahme ließ sich mangels
Supabase-Zugang nie überprüfen. Zernio beantwortet dieselbe Frage als **Auskunft**:
deterministisch, in 5 Minuten statt in Stunden, ohne jede Uhr.

Geblieben ist eine grobe Reißleine: `ageHours > 36`. Sie deckt den Restfall ab, dass
Zernio sich gesund meldet und trotzdem nichts ankommt. 36 h liegt weit über der
längsten je beobachteten natürlichen Lücke (16,3 h) und halbiert die blinde Zeit
gegenüber 48 h, falls der Zernio-Check ausfällt — er hängt an einem aus dem
Outreach-Projekt geborgten API-Key.

Die beiden historischen Fehlalarme bleiben als Regressionsfälle in
`test/ingestion.test.js`. Die Aktivstunden-Tests sind entfallen.

**Lehre:** Erst prüfen, ob die Quelle direkt befragt werden kann. Ein Rückschluss aus
Stille braucht immer Annahmen, und Annahmen über Uhrzeiten altern schlecht.

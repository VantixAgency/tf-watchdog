// Tests für die Ingestion-Reißleine.
//
// Geschichte dieses Checks, damit niemand den Kreis nochmal läuft:
//   1. Wanduhr, 12h  → Fehlalarm nach jeder ruhigen Nacht (07./08.08.2026).
//   2. Aktivstunden 09-23 → Fehlalarme weg, aber die Annahme "nachts schreibt
//      niemand" ließ sich mangels DB-Zugang nie überprüfen.
//   3. Zernio direkt fragen → dieselbe Auskunft in 5 Minuten, ohne jede Annahme.
//      Damit wurde die Aktivstunden-Mechanik überflüssig und ist wieder raus.
//
// Übrig bleibt eine grobe Reißleine für den Restfall "Zernio meldet sich gesund,
// es kommt trotzdem nichts an". Die beiden historischen Fehlalarme bleiben als
// Regressionsfälle stehen: Sie dürfen auch mit der einfachen Regel nicht feuern.

import test from "node:test";
import assert from "node:assert/strict";
import { ingestionVerdict } from "../api/check.js";

const ms = (iso) => new Date(iso).getTime();

test("Fehlalarm 07.08.2026 schlägt nicht an", () => {
  // Letzte DM Do 22:46, Alarm kam damals Fr 10:46 Berlin — 13,6h Lücke.
  const v = ingestionVerdict(ms("2026-08-06T20:46:00Z"), ms("2026-08-07T08:46:00Z"));
  assert.equal(v.dead, false);
  assert.equal(v.ageHours, 12);
});

test("Fehlalarm 08.08.2026 schlägt nicht an", () => {
  // Die längste je beobachtete natürliche Lücke: Fr 17:29 → Sa 09:45 = 16,3h.
  const v = ingestionVerdict(ms("2026-08-07T15:29:00Z"), ms("2026-08-08T07:45:00Z"));
  assert.equal(v.dead, false);
  assert.ok(v.ageHours > 16, `Vorbedingung verletzt: ${v.ageHours}`);
});

test("ein ganzes Wochenende Stille bleibt unter der Reißleine", () => {
  // Sa 20:00 → Mo 08:00 Berlin = 36h. Sonntags haben die Studios zu.
  const v = ingestionVerdict(ms("2026-08-08T18:00:00Z"), ms("2026-08-10T06:00:00Z"));
  assert.equal(v.ageHours, 36);
  assert.equal(v.dead, false);
});

test("darüber hinaus ist die Ingestion tot", () => {
  const v = ingestionVerdict(ms("2026-08-08T18:00:00Z"), ms("2026-08-10T07:00:00Z"));
  assert.equal(v.dead, true);
  assert.match(v.reason, /Schwelle 36h/);
});

test("der Juni-Ausfall wird sicher gemeldet", () => {
  const start = ms("2026-06-25T06:04:00Z"); // letzte ingested Message des echten Vorfalls
  assert.equal(ingestionVerdict(start, start + 13 * 24 * 3600 * 1000).dead, true);
});

test("frische Ingestion ist gesund", () => {
  const now = ms("2026-08-11T07:57:00Z");
  const v = ingestionVerdict(now - 2 * 60000, now);
  assert.equal(v.dead, false);
  assert.equal(v.reason, null);
});

test("die Schwelle ist einstellbar", () => {
  const now = ms("2026-08-11T07:57:00Z");
  assert.equal(ingestionVerdict(now - 20 * 3600 * 1000, now, { staleH: 12 }).dead, true);
});

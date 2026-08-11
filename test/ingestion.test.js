// Tests für die Ingestion-Stille-Bewertung.
//
// Hintergrund: Der Check maß früher reine Wanduhr-Zeit ("letzte DM älter als 12h
// = Ingestion tot") und schlug deshalb nach jeder ruhigen Nacht Alarm. Die beiden
// belegten Fehlalarme vom 07./08.08.2026 sind hier als Testfälle festgenagelt —
// sie dürfen nie wieder alarmieren, ohne dass es auffällt.

import test from "node:test";
import assert from "node:assert/strict";
import { activeHoursBetween, ingestionVerdict } from "../api/check.js";

const ms = (iso) => new Date(iso).getTime();

// Aktivfenster-Default: 09:00–23:00 Europe/Berlin
test("Nachtstrecke zählt nicht als Aktivzeit", () => {
  // Mo 23:00 → Di 08:00 Berlin: 9h Wanduhr, komplett außerhalb des Fensters
  const h = activeHoursBetween(ms("2026-08-10T21:00:00Z"), ms("2026-08-11T06:00:00Z"));
  assert.equal(h, 0);
});

test("voller Tag Stille ergibt die 14 Fensterstunden", () => {
  // Mo 09:00 → Di 09:00 Berlin
  const h = activeHoursBetween(ms("2026-08-10T07:00:00Z"), ms("2026-08-11T07:00:00Z"));
  assert.equal(h, 14);
});

test("Zeitumstellung Ende Oktober wird korrekt gerechnet", () => {
  // Sa 23:00 CEST → So 22:00 CET (Uhren gehen in dieser Nacht zurück).
  // 24h UTC, aber 25 Berliner Wanduhr-Stunden; aktiv ist nur So 09:00–22:00.
  const h = activeHoursBetween(ms("2026-10-24T21:00:00Z"), ms("2026-10-25T21:00:00Z"));
  assert.equal(h, 13);
});

test("Zeitraum ohne Dauer ist null Aktivstunden", () => {
  const t = ms("2026-08-10T07:00:00Z");
  assert.equal(activeHoursBetween(t, t), 0);
  assert.equal(activeHoursBetween(t, t - 3600000), 0);
});

test("Fehlalarm 07.08.2026 schlägt nicht mehr an", () => {
  // Letzte DM Do 22:46, Alarm kam Fr 10:46 Berlin.
  const v = ingestionVerdict(ms("2026-08-06T20:46:00Z"), ms("2026-08-07T08:46:00Z"));
  assert.equal(v.dead, false);
  assert.equal(v.ageHours, 12);
  assert.ok(v.activeHours < 3, `Aktivstunden zu hoch: ${v.activeHours}`);
});

test("Fehlalarm 08.08.2026 schlägt nicht mehr an", () => {
  // Letzte DM Fr 17:29, Alarm kam Sa 05:29 Berlin.
  const v = ingestionVerdict(ms("2026-08-07T15:29:00Z"), ms("2026-08-08T03:29:00Z"));
  assert.equal(v.dead, false);
  assert.ok(v.activeHours < 7, `Aktivstunden zu hoch: ${v.activeHours}`);
});

test("echte Stille über einen ganzen Geschäftstag alarmiert", () => {
  // Mo 09:00 → Di 09:00 Berlin: 14 Aktivstunden, Schwelle ist 12.
  const v = ingestionVerdict(ms("2026-08-10T07:00:00Z"), ms("2026-08-11T07:00:00Z"));
  assert.equal(v.dead, true);
  assert.match(v.reason, /Aktivstunden/);
});

test("der Juni-Ausfall wird am ersten Tag gemeldet, nicht am dreizehnten", () => {
  const start = ms("2026-06-25T06:04:00Z"); // letzte ingested Message des echten Vorfalls
  const nachEinemTag = start + 24 * 3600 * 1000;
  assert.equal(ingestionVerdict(start, nachEinemTag).dead, true);
});

test("Reißleine greift auch, wenn das Aktivfenster falsch geraten wäre", () => {
  // Fenster künstlich auf eine Stunde geschrumpft: Aktivstunden bleiben unter der
  // Schwelle, trotzdem muss nach 48h Wanduhr Alarm kommen.
  const from = ms("2026-08-10T07:00:00Z");
  const to = from + 50 * 3600 * 1000;
  const v = ingestionVerdict(from, to, { fromHour: 9, toHour: 10 });
  assert.ok(v.activeHours <= 12, `Vorbedingung verletzt: ${v.activeHours}`);
  assert.equal(v.dead, true);
  assert.match(v.reason, /48/);
});

test("frische Ingestion ist gesund", () => {
  // 09:57 Berlin, letzte DM vor zwei Minuten — der reale Zustand beim Live-Check.
  const now = ms("2026-08-11T07:57:00Z");
  const v = ingestionVerdict(now - 2 * 60000, now);
  assert.equal(v.dead, false);
  assert.ok(v.activeHours < 0.1, `Teilschritt falsch gezählt: ${v.activeHours}`);
});

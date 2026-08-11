// Tests für das KI-Antwortfenster.
//
// Hintergrund: Der Watchdog hatte das Fenster "Mo-Fr 18-10 + Sa/So" fest im Code
// und meldete hängende Chats NUR darin — Mo-Fr zwischen 10 und 18 Uhr war er also
// blind. In Wahrheit steht das Fenster pro Studio in der DB
// (ki_active_hours_start/_end/_weekend) und ist im Dashboard einstellbar.
// Der Monitor liest es jetzt dort, statt es zu raten.

import test from "node:test";
import assert from "node:assert/strict";
import { kiWindowActive } from "../api/check.js";

const ms = (iso) => new Date(iso).getTime();

// Referenzzeitpunkte (Berlin): Di 14:00 = Werktag mittags, Di 20:00 = Werktag
// abends, Di 09:00 = früh, Sa 14:00 = Wochenende.
const DI_MITTAG = ms("2026-08-11T12:00:00Z"); // Di 14:00
const DI_ABEND = ms("2026-08-11T18:00:00Z"); // Di 20:00
const DI_FRUEH = ms("2026-08-11T07:00:00Z"); // Di 09:00
const SA_MITTAG = ms("2026-08-08T12:00:00Z"); // Sa 14:00

const FENSTER_18_10 = {
  ki_active_hours_start: "18:00",
  ki_active_hours_end: "10:00",
  ki_active_weekend: true,
};

test("ohne konfiguriertes Fenster gilt rund um die Uhr", () => {
  // Wichtig: kein stilles Blindloch, wenn die Spalten leer sind.
  assert.equal(kiWindowActive({}, DI_MITTAG), true);
  assert.equal(kiWindowActive({ ki_active_hours_start: null, ki_active_hours_end: null }, DI_MITTAG), true);
});

test("Start gleich Ende bedeutet 24/7", () => {
  const acc = { ki_active_hours_start: "00:00", ki_active_hours_end: "00:00" };
  assert.equal(kiWindowActive(acc, DI_MITTAG), true);
  assert.equal(kiWindowActive(acc, DI_FRUEH), true);
});

test("Fenster über Mitternacht gilt abends und früh morgens", () => {
  assert.equal(kiWindowActive(FENSTER_18_10, DI_ABEND), true);
  assert.equal(kiWindowActive(FENSTER_18_10, DI_FRUEH), true);
});

test("Fenster über Mitternacht gilt werktags mittags NICHT", () => {
  // Das ist das Loch, das der Watchdog bisher hatte — hier sichtbar gemacht.
  assert.equal(kiWindowActive(FENSTER_18_10, DI_MITTAG), false);
});

test("Wochenende folgt dem Flag des Studios", () => {
  assert.equal(kiWindowActive(FENSTER_18_10, SA_MITTAG), true);
  assert.equal(kiWindowActive({ ...FENSTER_18_10, ki_active_weekend: false }, SA_MITTAG), false);
});

test("00:00:00-23:59:59 ist rund um die Uhr, auch in der letzten Minute", () => {
  // Genau so steht es real in der TF-DB (beide Studios, Stand 11.08.2026).
  // Naiv gerechnet wäre 23:59 Uhr aus dem Fenster gefallen = eine blinde Minute.
  const acc = {
    ki_active_hours_start: "00:00:00",
    ki_active_hours_end: "23:59:59",
    ki_active_weekend: true,
  };
  assert.equal(kiWindowActive(acc, DI_MITTAG), true);
  assert.equal(kiWindowActive(acc, SA_MITTAG), true);
  assert.equal(kiWindowActive(acc, ms("2026-08-11T21:59:30Z")), true); // Di 23:59:30 Berlin
});

test("Tagesfenster ohne Mitternachtssprung", () => {
  const acc = { ki_active_hours_start: "09:00", ki_active_hours_end: "17:00", ki_active_weekend: false };
  assert.equal(kiWindowActive(acc, DI_MITTAG), true);
  assert.equal(kiWindowActive(acc, DI_ABEND), false);
});

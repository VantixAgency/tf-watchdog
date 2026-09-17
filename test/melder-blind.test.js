// Zwei Regeln, die der Vorfall vom 17.09.2026 erzwungen hat:
//
//   1. Ein Melder, der nicht hineinschauen kann, sagt das — er schweigt nicht.
//   2. Ein neuer Alarmgrund braucht einen eigenen Fingerabdruck, sonst schluckt die
//      Entprellung ihn als "schon gemeldet".
//
// Punkt 2 klingt nach Kleinkram und ist der Unterschied zwischen einer Mail und
// keiner Mail: `decideAlert` vergleicht Fingerabdruecke. Tragen zwei verschiedene
// Probleme denselben Abdruck, gilt das zweite als Wiederholung des ersten.

import test from "node:test";
import assert from "node:assert/strict";
import { computeFingerprint, decideAlert } from "../api/check.js";

const LEER = { ingestion: {}, n8n: { ok: true }, execErrors: {}, replyGap: {}, zernio: {}, v2: {}, kanalWirkung: {} };

const stumm = (kanal = "muenchen/whatsapp") => ({
  ...LEER,
  kanalWirkung: { ok: false, befunde: [{ kanal, art: "kanal_stumm", text: "…" }] },
});

test("ein stummer Kanal hat einen eigenen Fingerabdruck", () => {
  const fpKanal = computeFingerprint(stumm(), true);
  const fpN8n = computeFingerprint({ ...LEER, n8n: { ok: false } }, true);
  assert.notEqual(fpKanal, fpN8n, "sonst gilt der Kanalausfall als Wiederholung des n8n-Ausfalls");
});

test("zwei verschiedene stumme Kanaele sind zwei verschiedene Probleme", () => {
  assert.notEqual(
    computeFingerprint(stumm("muenchen/whatsapp"), true),
    computeFingerprint(stumm("landshut/instagram"), true),
  );
});

test("derselbe Kanal mit demselben Grund behaelt seinen Abdruck", () => {
  // Wichtig fuer die Entprellung: Der Abdruck darf sich nicht bei jedem Ping aendern,
  // solange dasselbe Problem anhaelt — sonst wird NIE gemailt (fp !== prev).
  const a = computeFingerprint(stumm(), true);
  const b = computeFingerprint(stumm(), true);
  assert.equal(a, b);
});

test("Stillstand und Pausenwelle desselben Kanals sind unterscheidbar", () => {
  const welle = { ...LEER, kanalWirkung: { ok: false, befunde: [{ kanal: "muenchen/whatsapp", art: "pausenwelle" }] } };
  assert.notEqual(computeFingerprint(stumm(), true), computeFingerprint(welle, true));
});

test("ein stummer Kanal wird nach der zweiten Sichtung wirklich gemailt", () => {
  const fp = computeFingerprint(stumm(), true);
  // Erste Sichtung: noch nichts, das Problem muss sich bestaetigen.
  assert.equal(decideAlert({ hasProblems: true, fp, prev: "OK", alertedFp: "OK", sinceAlert: 0, remind: 7200 }), "none");
  // Zweite Sichtung, 5 Minuten spaeter: jetzt raus damit.
  assert.equal(decideAlert({ hasProblems: true, fp, prev: fp, alertedFp: "OK", sinceAlert: 300, remind: 7200 }), "problem");
});

test("ein blinder Melder ist ein eigener Zustand, keine Gesundheit", () => {
  const blind = { ...LEER, execErrors: { ok: false, blind: true, note: "HTTP 401" } };
  const fp = computeFingerprint(blind, true);
  assert.match(fp, /blind:true/);
  assert.notEqual(fp, computeFingerprint(LEER, true));
});

test("ein gesunder Lauf bleibt OK", () => {
  assert.equal(computeFingerprint(LEER, false), "OK");
});

test("ein uebersprungener Kanal-Check macht den Fingerabdruck nicht zum Problem", () => {
  // Gleiche Vorsicht wie bei Zernio und V2: kein `ok`-Feld heisst "nicht geprueft",
  // nicht "kaputt".
  const uebersprungen = { ...LEER, kanalWirkung: { skipped: true, reason: "nicht konfiguriert" } };
  assert.match(computeFingerprint(uebersprungen, true), /kanal:\|/);
});

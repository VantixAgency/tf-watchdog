// Melder fuer die V2-Installation.
//
// Der Pruefgegenstand ist nicht "antwortet der Dienst". Ein Melder, der auf HTTP 200
// stehenbleibt, laesst eine stillschweigend abgeschaltete Absicherung durchgehen --
// eine Tabelle ohne RLS, eine nicht angewendete Migration, einen auf den lokalen
// Ersatz zurueckgefallenen Auth-Adapter. Genau diese Faelle stehen hier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pruefeKonfiguration, PRUEFUNGEN, BRAUCHT_N8N } from '../config/schema.mjs';
import { computeFingerprint, checkV2Bereit } from '../api/check.js';

const konfiguration = JSON.parse(readFileSync(new URL('../config/installationen.json', import.meta.url), 'utf8'));
const v2 = konfiguration.organisationen.find((o) => o.id === 'tf-lead-funnel-v2-staging');

test('die V2-Installation steht in der Konfiguration und ist gueltig', () => {
  assert.ok(v2, 'Organisation tf-lead-funnel-v2-staging fehlt');
  const r = pruefeKonfiguration(konfiguration);
  assert.deepEqual(r.fehler, []);
});

test('sie hat einen EIGENEN Alarmempfaenger', () => {
  const tf = konfiguration.organisationen.find((o) => o.id === 'tattoo-fashion');
  const gemeinsam = (v2.alarm.email ?? []).filter((a) => (tf.alarm.email ?? []).includes(a));
  // Ein gemeinsamer Empfaenger waere schlimmer als keiner: Ein Staging-Alarm um drei Uhr
  // nachts gewoehnt einen daran, die Meldung wegzuklicken -- und dann verschwindet der
  // echte Produktivalarm in derselben Bewegung.
  assert.deepEqual(gemeinsam, [], 'Staging und Produktion teilen sich einen Empfaenger');
  assert.ok((v2.alarm.email ?? []).length > 0, 'kein Empfaenger — Alarme gingen ins Leere');
});

test('sie prueft NICHT ueber n8n', () => {
  assert.deepEqual(v2.pruefungen.filter((p) => BRAUCHT_N8N.includes(p)), []);
  assert.equal(v2.n8nUrl, undefined);
  assert.ok(v2.pruefungen.includes('v2_bereitschaft'));
});

test('v2_bereitschaft ist eine erlaubte Pruefung', () => {
  assert.ok(PRUEFUNGEN.includes('v2_bereitschaft'));
});

test('ohne v2Url wird die Konfiguration ABGELEHNT', () => {
  // Der gefaehrlichste Zustand ist ein Melder ohne Ziel: Er prueft nichts und meldet
  // trotzdem "ok". Deshalb muss das ein harter Konfigurationsfehler sein.
  const kaputt = JSON.parse(JSON.stringify(konfiguration));
  const o = kaputt.organisationen.find((x) => x.id === 'tf-lead-funnel-v2-staging');
  delete o.v2Url;
  const r = pruefeKonfiguration(kaputt);
  assert.ok(r.fehler.some((f) => /v2Url fehlt/.test(f)), r.fehler.join(' | '));
});

test('eine ungueltige v2Url wird abgelehnt', () => {
  const kaputt = JSON.parse(JSON.stringify(konfiguration));
  kaputt.organisationen.find((x) => x.id === 'tf-lead-funnel-v2-staging').v2Url = 'http://unverschluesselt.example';
  assert.ok(pruefeKonfiguration(kaputt).fehler.some((f) => /v2Url ist keine https-URL/.test(f)));
});

test('ein V2-Ausfall traegt einen eigenen Fingerabdruck', () => {
  // Ohne eigenes Feld haette ein V2-Ausfall denselben Abdruck wie ein n8n-Ausfall. Die
  // Entprellung haette den zweiten Alarm dann als Wiederholung des ersten verschluckt.
  const ohne = computeFingerprint({ v2: { ok: true } }, true);
  const mit  = computeFingerprint({ v2: { ok: false } }, true);
  assert.notEqual(ohne, mit);
});

test('ein uebersprungener V2-Check gilt nicht als Problem', () => {
  const uebersprungen = computeFingerprint({ v2: { skipped: true, reason: 'nicht konfiguriert' } }, true);
  const gesund = computeFingerprint({ v2: { ok: true } }, true);
  assert.equal(uebersprungen, gesund);
});

// ── Die eigentlichen Meldefaelle ────────────────────────────────────────────
//
// Geprueft wird die Auswertung, nicht das Netz: Der Endpunkt wird ersetzt, damit jeder
// Fall deterministisch ist. Was hier NICHT geprueft wird, ist der Netzweg selbst --
// das leistet der Lauf gegen das echte Staging.

/** Antwortet an Stelle des Netzes. So ist jeder Fall deterministisch. */
const stub = (bereit, { gesund = { ok: true }, gesundStatus = 200, bereitStatus = 200 } = {}) =>
  async (url) => String(url).endsWith('/api/gesund')
    ? { status: gesundStatus, json: async () => gesund }
    : { status: bereitStatus, json: async () => bereit };

const GESUND = Object.freeze({ ok: true, migrationen: 20, tabellen: 31, tabellenOhneRls: 0,
                               auth: 'supabase', benutzerkontext: true });
const ORG = { v2Url: 'https://beispiel.invalid' };

test('gesunder Dienst: kein Problem', async () => {
  const r = await checkV2Bereit(ORG, stub(GESUND));
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
});

test('eine Tabelle ohne RLS ist ein Problem', async () => {
  const r = await checkV2Bereit(ORG, stub({ ...GESUND, ok: false, tabellenOhneRls: 1 }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /OHNE Row Level Security/.test(p)), r.problems.join(' | '));
});

test('ein zurueckgefallener Auth-Adapter ist ein Problem', async () => {
  // Der gefaehrlichste stille Rueckfall: Der Dienst antwortet mit 200, laeuft aber auf
  // dem lokalen Ersatzadapter -- also ohne die echte Supabase-Kette.
  const r = await checkV2Bereit(ORG, stub({ ...GESUND, auth: 'lokal' }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /Ersatzadapter/.test(p)), r.problems.join(' | '));
});

test('fehlender Benutzerkontext ist ein Problem', async () => {
  const r = await checkV2Bereit(ORG, stub({ ...GESUND, benutzerkontext: false }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /Benutzerkontext nicht verdrahtet/.test(p)));
});

test('null Migrationen sind ein Problem', async () => {
  const r = await checkV2Bereit(ORG, stub({ ...GESUND, ok: false, migrationen: 0 }));
  assert.ok(r.problems.some((p) => /keine Migration angewendet/.test(p)));
});

test('ein Dienst, der sich als nicht bereit meldet, ist ein Problem', async () => {
  const r = await checkV2Bereit(ORG, stub({ ...GESUND, ok: false }));
  assert.ok(r.problems.some((p) => /NICHT bereit/.test(p)));
});

test('fehlendes Lebenszeichen ist ein Problem', async () => {
  const r = await checkV2Bereit(ORG, stub(GESUND, { gesund: { ok: false }, gesundStatus: 503 }));
  assert.ok(r.problems.some((p) => /Lebenszeichen fehlt/.test(p)));
});

test('ein nicht erreichbarer Dienst ist ein Problem, kein stiller Erfolg', async () => {
  const r = await checkV2Bereit(ORG, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.ok, false);
  assert.ok(r.problems.length > 0);
});

test('ohne v2Url wird uebersprungen und NICHT als ok gemeldet', async () => {
  const r = await checkV2Bereit({}, stub(GESUND));
  assert.equal(r.skipped, true);
  assert.notEqual(r.ok, true);
});

test('MUTATIONSNACHWEIS: eine entschaerfte Pruefung faellt auf', async () => {
  // Waere die RLS-Pruefung ausgebaut, muesste dieser Fall gruen durchgehen. Er tut es
  // nicht -- also prueft sie wirklich.
  const kaputt = { ...GESUND, tabellenOhneRls: 3 };
  const r = await checkV2Bereit(ORG, stub(kaputt));
  assert.equal(r.ok, false, 'Eine Installation mit 3 ungeschuetzten Tabellen galt als gesund');
});

test('die erwartete Migrationszahl steht NICHT in der Konfiguration', () => {
  // Eine Zahl, die nur in einer Konfiguration lebt, muss bei jeder Migration
  // nachgezogen werden. Vergisst man das, meldet der Waechter Alarm ohne Anlass --
  // und man gewoehnt sich das Wegklicken an.
  assert.ok(!/migrationen/i.test(JSON.stringify(v2)), 'Migrationszahl in der Konfiguration gefunden');
});

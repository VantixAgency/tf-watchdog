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
const stub = (bereit, { gesund = { ok: true }, gesundStatus = 200, bereitStatus = 200,
                        betrieb = null, betriebStatus = 200 } = {}) =>
  async (url) => {
    const u = String(url);
    if (u.endsWith('/api/gesund')) return { status: gesundStatus, json: async () => gesund };
    if (u.endsWith('/api/betrieb')) return { status: betriebStatus, json: async () => (betrieb ?? BETRIEB) };
    return { status: bereitStatus, json: async () => bereit };
  };

const GESUND = Object.freeze({ ok: true, migrationen: 20, tabellen: 31, tabellenOhneRls: 0,
                               auth: 'supabase', benutzerkontext: true });

/** Ein unauffaelliger Betriebsstand. Jeder Meldefall weicht davon in EINER Zahl ab. */
const BETRIEB = Object.freeze({
  migrationen: 32, letzteMigration: new Date().toISOString(), tabellen: 38, tabellenOhneRls: 0,
  letzterEingang: new Date().toISOString(), letzteZustellung: new Date().toISOString(),
  retryStau: 0, dlqTiefe: 0,
  schatten: { gesamt24h: 0, laxer24h: 0, abweichungen24h: 0 },
  kanaele: { gesamt: 3, fehlerhaft: 0 },
  organisationen: 2, haengendeOnboardings: 0,
});

const ORG = { v2Url: 'https://beispiel.invalid', schwellen: {} };

// Der Melder braucht ein Token, sonst meldet er (richtig) "ungeprueft".
process.env.V2_BETRIEB_TOKEN = 'test-token';

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

// ── Betriebszahlen: der Unterschied zwischen "lebt" und "arbeitet" ──────────

test('ohne Betriebstoken meldet der Melder AUSDRUECKLICH ungeprueft', async () => {
  // Kein Token heisst nicht "alles gut". Ein halb verdrahteter Melder, der gruen
  // meldet, ist schlimmer als gar keiner -- man verlaesst sich auf ihn.
  const alt = process.env.V2_BETRIEB_TOKEN;
  delete process.env.V2_BETRIEB_TOKEN;
  const r = await checkV2Bereit(ORG, stub(GESUND));
  process.env.V2_BETRIEB_TOKEN = alt;
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /ungeprueft/.test(p)), r.problems.join(' | '));
});

test('ein Retry-Stau ueber der Schwelle ist ein Problem', async () => {
  const r = await checkV2Bereit({ ...ORG, schwellen: { retryStau: 25 } },
    stub(GESUND, { betrieb: { ...BETRIEB, retryStau: 40 } }));
  assert.ok(r.problems.some((p) => /Retry-Stau: 40/.test(p)), r.problems.join(' | '));
});

test('ein Retry-Stau UNTER der Schwelle ist keiner', async () => {
  // Die Flughoehe ist der Punkt: Ein einzelner Wiederholungsversuch ist normaler
  // Betrieb. Ein Melder, der ab dem ersten feuert, wird weggeklickt.
  const r = await checkV2Bereit({ ...ORG, schwellen: { retryStau: 25 } },
    stub(GESUND, { betrieb: { ...BETRIEB, retryStau: 12 } }));
  assert.deepEqual(r.problems, []);
});

test('eine zu tiefe DLQ ist ein Problem', async () => {
  const r = await checkV2Bereit({ ...ORG, schwellen: { dlqTiefe: 10 } },
    stub(GESUND, { betrieb: { ...BETRIEB, dlqTiefe: 11 } }));
  assert.ok(r.problems.some((p) => /DLQ-Tiefe 11/.test(p)), r.problems.join(' | '));
});

test('im Schattenbetrieb alarmiert NUR die gefaehrliche Richtung', async () => {
  // `v2_strenger` ist die gewollte Richtung. Beides in eine Zahl zu werfen haette
  // den Melder bei jeder gewollten Verschaerfung rot gemacht.
  const strenger = await checkV2Bereit(ORG,
    stub(GESUND, { betrieb: { ...BETRIEB, schatten: { gesamt24h: 50, laxer24h: 0, abweichungen24h: 9 } } }));
  assert.deepEqual(strenger.problems, [], strenger.problems.join(' | '));

  const laxer = await checkV2Bereit(ORG,
    stub(GESUND, { betrieb: { ...BETRIEB, schatten: { gesamt24h: 50, laxer24h: 1, abweichungen24h: 9 } } }));
  assert.ok(laxer.problems.some((p) => /LAXER/.test(p)), laxer.problems.join(' | '));
});

test('ein fehlerhafter Kanal ist ein Problem', async () => {
  const r = await checkV2Bereit(ORG,
    stub(GESUND, { betrieb: { ...BETRIEB, kanaele: { gesamt: 3, fehlerhaft: 1 } } }));
  assert.ok(r.problems.some((p) => /1 von 3 Kanaelen/.test(p)), r.problems.join(' | '));
});

test('Stille im Eingang meldet nur, wenn eine Schwelle gesetzt ist', async () => {
  // In Staging kommt tagelang nichts an. Ohne diese Unterscheidung waere der
  // Staging-Melder dauerhaft rot -- und damit wertlos.
  const lange = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  const ohne = await checkV2Bereit(ORG, stub(GESUND, { betrieb: { ...BETRIEB, letzterEingang: lange } }));
  assert.deepEqual(ohne.problems, []);

  const mit = await checkV2Bereit({ ...ORG, schwellen: { eingangStilleMin: 60 } },
    stub(GESUND, { betrieb: { ...BETRIEB, letzterEingang: lange } }));
  assert.ok(mit.problems.some((p) => /kein eingehendes Ereignis/.test(p)), mit.problems.join(' | '));
});

test('ein haengendes Onboarding ist ein Problem', async () => {
  const r = await checkV2Bereit(ORG, stub(GESUND, { betrieb: { ...BETRIEB, haengendeOnboardings: 2 } }));
  assert.ok(r.problems.some((p) => /Onboarding-Sitzung/.test(p)), r.problems.join(' | '));
});

test('nicht abrufbare Betriebszahlen sind ein Problem, kein stilles Gruen', async () => {
  const r = await checkV2Bereit(ORG, stub(GESUND, { betriebStatus: 401 }));
  assert.ok(r.problems.some((p) => /nicht abrufbar \(Status 401\)/.test(p)), r.problems.join(' | '));
});

test('die Staging-Konfiguration setzt bewusst KEINE Stilleschwellen', () => {
  assert.equal(Number(v2.schwellen.eingangStilleMin), 0);
  assert.equal(Number(v2.schwellen.zustellungStilleMin), 0);
  assert.ok(Number(v2.schwellen.retryStau) > 0, 'Stau und DLQ haben sehr wohl Schwellen');
  assert.ok(Number(v2.schwellen.dlqTiefe) > 0);
  assert.equal(v2.secretRefs.betriebToken, 'V2_BETRIEB_TOKEN');
});

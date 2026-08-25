import { test } from 'node:test';
import assert from 'node:assert/strict';
import { istAusfall, planAlerts, DEFAULTS } from '../n8n/alarm-flughoehe.js';

const MIN = 60 * 1000;
const dm = (stuckCount, oldestStuckMin) => ({
  slug: 'muenchen', name: 'Tattoo Fashion Muenchen',
  kind: 'Unbeantwortete DMs', stuckCount, oldestStuckMin, detail: 'x',
});
const err = (errorCount) => ({
  slug: 'landshut', name: 'Tattoo Fashion Landshut',
  kind: 'Verarbeitungsfehler', errorCount, detail: 'x',
});
// zwei Läufe hintereinander durchspielen (Persistenz)
const zweimal = (problems, opts) => {
  const a = planAlerts({ problems, now: 0, state: {}, opts });
  return planAlerts({ problems, now: 3 * MIN, state: a.state, opts });
};

test('ECHTER FALL 25.08.: ein Chat wartet 7 Min -> keine Meldung', () => {
  assert.equal(istAusfall(dm(1, 7)), false);
  assert.equal(zweimal([dm(1, 7)]).send.length, 0);
});

test('ECHTER FALL 24.08.: 10 Verarbeitungsfehler -> Meldung', () => {
  assert.equal(istAusfall(err(10)), true);
  assert.equal(zweimal([err(10)]).send.length, 1);
});

test('Stau: drei Chats gleichzeitig -> Meldung', () => {
  assert.equal(istAusfall(dm(3, 8)), true);
  assert.equal(zweimal([dm(3, 8)]).send.length, 1);
});

test('zwei Chats sind noch kein Stau', () => {
  assert.equal(istAusfall(dm(2, 8)), false);
});

test('Liegenbleiber: ein Chat 60 Min -> Meldung trotz Einzelfall', () => {
  assert.equal(istAusfall(dm(1, 60)), true);
  assert.equal(zweimal([dm(1, 60)]).send.length, 1);
});

test('59 Min sind noch kein Liegenbleiber', () => {
  assert.equal(istAusfall(dm(1, 59)), false);
});

test('ein einzelner Verarbeitungsfehler meldet nicht', () => {
  assert.equal(istAusfall(err(1)), false);
  assert.equal(istAusfall(err(2)), false);
});

test('Persistenz: erster Anblick ist still, zweiter meldet', () => {
  const a = planAlerts({ problems: [dm(3, 8)], now: 0, state: {} });
  assert.equal(a.send.length, 0, 'erster Lauf muss still sein');
  assert.match(a.suppressed[0].grund, /wartet auf/);
  const b = planAlerts({ problems: [dm(3, 8)], now: 3 * MIN, state: a.state });
  assert.equal(b.send.length, 1, 'zweiter Lauf meldet');
});

test('fluechtiges Problem (nur ein Lauf) meldet nie', () => {
  const a = planAlerts({ problems: [dm(4, 9)], now: 0, state: {} });
  const b = planAlerts({ problems: [], now: 3 * MIN, state: a.state });
  const c = planAlerts({ problems: [dm(4, 9)], now: 6 * MIN, state: b.state });
  assert.equal(a.send.length + b.send.length + c.send.length, 0);
});

test('Cooldown: dasselbe Problem nicht erneut binnen 30 Min', () => {
  const a = zweimal([dm(3, 8)]);
  assert.equal(a.send.length, 1);
  const b = planAlerts({ problems: [dm(3, 8)], now: 3 * MIN + 20 * MIN, state: a.state });
  assert.equal(b.send.length, 0);
  assert.equal(b.suppressed[0].grund, 'Cooldown laeuft');
  const c = planAlerts({ problems: [dm(3, 8)], now: 3 * MIN + 31 * MIN, state: b.state });
  assert.equal(c.send.length, 1, 'nach 30 Min wieder erlaubt');
});

test('unbekannte Problemklasse wird NICHT still geschluckt', () => {
  const neu = { slug: 'muenchen', kind: 'Ingestion tot', detail: 'x' };
  assert.equal(istAusfall(neu), true);
  assert.equal(zweimal([neu]).send.length, 1);
});

test('Schwellen sind ueberschreibbar', () => {
  assert.equal(istAusfall(dm(2, 8), { dmStuckCount: 2 }), true);
  assert.equal(istAusfall(err(1), { errorCount: 1 }), true);
  // ohne Persistenz-Anforderung meldet schon der erste Anblick
  const sofort = planAlerts({ problems: [dm(3, 8)], now: 0, state: {}, opts: { requireConsecutive: false } });
  assert.equal(sofort.send.length, 1);
});

test('planAlerts veraendert den uebergebenen State nicht', () => {
  const state = { lastAlert: {}, pending: {} };
  planAlerts({ problems: [dm(3, 8)], now: 0, state });
  assert.deepEqual(state, { lastAlert: {}, pending: {} });
});

test('Defaults sind die dokumentierten Schwellen', () => {
  assert.equal(DEFAULTS.dmStuckCount, 3);
  assert.equal(DEFAULTS.dmHardMin, 60);
  assert.equal(DEFAULTS.errorCount, 3);
});

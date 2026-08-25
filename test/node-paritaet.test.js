// Paritaetstest: der n8n-Code-Node kann nicht importieren, die Flughoehen-Logik lebt
// dort also als KOPIE. Eine Kopie, die niemand prueft, laeuft irgendwann auseinander —
// und dann testet man das eine und betreibt das andere. Dieser Test zieht die
// Funktionen aus dem Live-Snapshot des Nodes und laesst sie gegen das Modul antreten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as modul from '../n8n/alarm-flughoehe.js';

const hier = dirname(fileURLToPath(import.meta.url));
const snapshot = readFileSync(join(hier, '..', 'n8n', 'health-check.live.js'), 'utf8');

// Den Flughoehen-Block aus dem Node-Code herausschneiden (bis zur ersten Zeile,
// die wieder n8n-Globals benutzt).
const von = snapshot.indexOf('const FLUGHOEHE=');
const bis = snapshot.indexOf('sd.pending=sd.pending||{};');
assert.ok(von > 0 && bis > von, 'Flughoehen-Block im Live-Snapshot nicht gefunden');
const block = snapshot.slice(von, bis);
const node = new Function(block + '\nreturn {FLUGHOEHE, istAusfall, planAlerts};')();

const nodeIstAusfall = (p) => node.istAusfall(p, node.FLUGHOEHE);
const nodePlan = (problems, now, state) =>
  node.planAlerts(problems, now, state, node.FLUGHOEHE);

const MIN = 60 * 1000;
const faelle = [
  { slug: 'muenchen', kind: 'Unbeantwortete DMs', stuckCount: 1, oldestStuckMin: 7 },
  { slug: 'muenchen', kind: 'Unbeantwortete DMs', stuckCount: 1, oldestStuckMin: 25 },
  { slug: 'muenchen', kind: 'Unbeantwortete DMs', stuckCount: 1, oldestStuckMin: 59 },
  { slug: 'muenchen', kind: 'Unbeantwortete DMs', stuckCount: 1, oldestStuckMin: 60 },
  { slug: 'muenchen', kind: 'Unbeantwortete DMs', stuckCount: 2, oldestStuckMin: 9 },
  { slug: 'landshut', kind: 'Unbeantwortete DMs', stuckCount: 3, oldestStuckMin: 9 },
  { slug: 'landshut', kind: 'Unbeantwortete DMs', stuckCount: 7, oldestStuckMin: 12 },
  { slug: 'landshut', kind: 'Verarbeitungsfehler', errorCount: 1 },
  { slug: 'landshut', kind: 'Verarbeitungsfehler', errorCount: 2 },
  { slug: 'landshut', kind: 'Verarbeitungsfehler', errorCount: 3 },
  { slug: 'landshut', kind: 'Verarbeitungsfehler', errorCount: 10 },
  { slug: 'muenchen', kind: 'Ingestion tot' },
];

test('Node-Kopie und Modul urteilen bei jedem Fall gleich', () => {
  for (const f of faelle) {
    assert.equal(nodeIstAusfall(f), modul.istAusfall(f),
      `Abweichung bei ${f.kind} ${JSON.stringify(f)}`);
  }
});

test('Node-Kopie und Modul melden ueber drei Laeufe dieselben Probleme', () => {
  let sN = { lastAlert: {}, pending: {} };
  let sM = { lastAlert: {}, pending: {} };
  for (let lauf = 0; lauf < 3; lauf++) {
    const now = lauf * 3 * MIN;
    const rN = nodePlan(faelle, now, sN);
    const rM = modul.planAlerts({ problems: faelle, now, state: sM });
    assert.deepEqual(
      rN.send.map((p) => p.slug + '|' + p.kind),
      rM.send.map((p) => p.slug + '|' + p.kind),
      `Lauf ${lauf}: unterschiedliche Meldungen`);
    assert.deepEqual(
      rN.suppressed.map((p) => p.grund),
      rM.suppressed.map((p) => p.grund),
      `Lauf ${lauf}: unterschiedliche Gruende`);
    sN = rN.state; sM = rM.state;
  }
});

test('Node-Kopie benutzt die dokumentierten Schwellen', () => {
  assert.equal(node.FLUGHOEHE.dmStuckCount, modul.DEFAULTS.dmStuckCount);
  assert.equal(node.FLUGHOEHE.dmHardMin, modul.DEFAULTS.dmHardMin);
  assert.equal(node.FLUGHOEHE.errorCount, modul.DEFAULTS.errorCount);
  assert.equal(node.FLUGHOEHE.cooldownMs, modul.DEFAULTS.cooldownMs);
});

test('der Live-Node meldet reine KI-Zustandsinfos nicht mehr', () => {
  assert.match(snapshot, /summarizeNotes\(allNotes\.filter\(n=>n&&n\.kind==='escalation'\)\)/,
    'Info-Filter fehlt im Live-Node');
});

test('ECHTER FALL 25.08. gegen den Live-Node: ein Chat, 7 Min -> still', () => {
  const p = [{ slug: 'muenchen', kind: 'Unbeantwortete DMs', stuckCount: 1, oldestStuckMin: 7 }];
  let s = { lastAlert: {}, pending: {} };
  for (let i = 0; i < 10; i++) {
    const r = nodePlan(p, i * 3 * MIN, s);
    assert.equal(r.send.length, 0, `Lauf ${i} haette gemeldet`);
    s = r.state;
  }
});

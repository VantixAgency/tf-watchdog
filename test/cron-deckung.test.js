// Jede konfigurierte Organisation muss auch tatsaechlich abgefragt werden.
//
// Befund, der zu diesem Test gefuehrt hat: `vercel.json` rief `/api/check` OHNE `?org=`
// auf. Der Endpunkt prueft dann die ERSTE Organisation. Eine zweite Installation stand
// damit zwar in der Konfiguration, wurde aber nie geprueft -- der Waechter haette
// gemeldet, alles sei in Ordnung, ohne je hingesehen zu haben. Das ist schlimmer als
// gar kein Waechter, weil man sich darauf verlaesst.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lies = (datei) => JSON.parse(readFileSync(new URL(datei, import.meta.url), 'utf8'));
const konfiguration = lies('../config/installationen.json');
const vercel = lies('../vercel.json');

const geprueft = (vercel.crons ?? []).map((c) => new URLSearchParams(String(c.path).split('?')[1] ?? '').get('org'));

test('jede Organisation hat einen eigenen Cron-Eintrag', () => {
  for (const org of konfiguration.organisationen)
    assert.ok(geprueft.includes(org.id), `Organisation "${org.id}" wird von keinem Cron abgefragt`);
});

test('kein Cron laeuft ohne ausdrueckliche Organisation', () => {
  // Ohne `?org=` traefe es stillschweigend die erste -- und welche das ist, haengt an
  // der Reihenfolge in einer JSON-Datei.
  assert.deepEqual(geprueft.filter((o) => !o), [], 'Es gibt einen Cron ohne ?org=');
});

test('kein Cron zeigt auf eine unbekannte Organisation', () => {
  const bekannt = konfiguration.organisationen.map((o) => o.id);
  for (const o of geprueft) assert.ok(bekannt.includes(o), `Cron fuer unbekannte Organisation "${o}"`);
});

test('die Laeufe liegen zeitlich auseinander', () => {
  // Gleichzeitige Laeufe teilen sich das Zeitfenster und die Ratengrenzen des Anbieters.
  const zeiten = (vercel.crons ?? []).map((c) => c.schedule);
  assert.equal(new Set(zeiten).size, zeiten.length, 'Zwei Crons laufen zur selben Zeit');
});

// Watchdog-Kette (Masterplan 16.10.2026, Paket W).
//
// Befund, der zu diesen Tests gefuehrt hat: Die Kette hat sich von Juli bis
// 16.10. NIE selbst verlaengert. `gh workflow run watchdog.yml || true` lief ohne
// Repo-Angabe und ohne Checkout -> "not a git repository", das `|| true` hat es
// verschluckt. Getragen hat allein der stuendliche Schedule, den GitHub nur alle
// 3-7 h liefert: 32 Luecken > 6 min in 1038 h.
//
// Teil 1 prueft die Workflow-Dateien als Text (keine YAML-Abhaengigkeit im Repo).
// Teil 2 faehrt die echten Skripte gegen einen nachgebauten Endpoint, einen
// nachgebauten healthchecks.io und ein nachgebautes `gh`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const lies = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
// Kommentarzeilen raus: der Kopfkommentar zitiert den alten Fehler woertlich.
const ohneKommentar = (t) => t.split('\n').filter((z) => !/^\s*#/.test(z)).join('\n');
const kette = ohneKommentar(lies('../.github/workflows/watchdog.yml'));
const heiler = lies('../.github/workflows/heiler.yml');
const keep = lies('../.github/workflows/keepalive.yml');
const weiter = ohneKommentar(lies('../scripts/weiter.sh'));
const konfig = JSON.parse(lies('../config/installationen.json'));
const SKRIPTE = new URL('../scripts/', import.meta.url).pathname;

// ── Teil 1: Dateien ──────────────────────────────────────────────────────────

test('watchdog.yml hat KEINEN schedule (sonst verdraengt er das Folgeglied mit Zustand)', () => {
  assert.doesNotMatch(kette, /^\s*schedule\s*:/m);
  assert.match(kette, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*zustand:/);
});

test('Dispatch mit Repo-Angabe und ohne verschlucktes Scheitern', () => {
  assert.match(weiter, /gh workflow run watchdog\.yml -R "\$repo"/);
  assert.doesNotMatch(weiter + kette, /gh workflow run[^\n]*\|\|\s*true/);
  assert.match(kette, /actions\/checkout@v4/);
});

test('Zustand kommt ueber env in die Shell, nie als Ausdruck ins Skript (Injection)', () => {
  // Alle run-Bloecke (run: | plus eingerueckte Folgezeilen) einsammeln.
  const zeilen = kette.split('\n');
  const run = [];
  zeilen.forEach((z, i) => {
    const m = z.match(/^(\s*)run:(.*)$/);
    if (!m) return;
    run.push(m[2]);
    for (let j = i + 1; j < zeilen.length && (zeilen[j].match(/^\s*/)[0].length > m[1].length || !zeilen[j].trim()); j++) run.push(zeilen[j]);
  });
  assert.ok(run.length > 0);
  assert.ok(!run.some((z) => z.includes('${{')), 'Ausdruck direkt im run-Block');
  assert.match(kette, /ZUSTAND: \$\{\{ inputs\.zustand \}\}/);
});

test('ORGS ist Teilmenge der konfigurierten Organisationen', () => {
  const m = kette.match(/^\s*ORGS:\s*([^#\n]+)/m);
  assert.ok(m, 'ORGS fehlt');
  const bekannt = konfig.organisationen.map((o) => o.id);
  for (const o of m[1].trim().split(/\s+/)) assert.ok(bekannt.includes(o), `unbekannte Organisation ${o}`);
});

test('concurrency: laufendes Glied wird nie abgebrochen; Heiler und Keepalive in eigenen Gruppen', () => {
  assert.match(kette, /group: tf-watchdog-chain\s*\n\s*cancel-in-progress: false/);
  assert.match(heiler, /group: tf-watchdog-heiler/);
  assert.match(keep, /group: tf-watchdog-keepalive/);
  assert.doesNotMatch(heiler + keep, /group: tf-watchdog-chain/);
});

test('contents: write nur im Keepalive', () => {
  assert.doesNotMatch(kette, /contents: write/);
  assert.doesNotMatch(heiler, /contents: write/);
  assert.match(keep, /contents: write/);
  assert.match(keep, /\[skip ci\]/);
  assert.match(keep, /actions\/workflows\/\$\{w\}\/enable/);
  assert.match(keep, /for w in watchdog\.yml heiler\.yml keepalive\.yml/);
});

test('Folgeglied startet auch, wenn die Ping-Schleife scheitert', () => {
  assert.match(kette, /Kette fortsetzen[^\n]*\n\s*if: always\(\)/);
});

// ── Teil 2: Skripte gegen Nachbauten ────────────────────────────────────────

function lauf(cmd, args, env) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => res({ code, out }));
  });
}

async function server(handler) {
  const anfragen = [];
  const s = createServer((req, res) => { anfragen.push(req.url); handler(req, res, anfragen); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, anfragen, zu: () => s.close() };
}

test('kette.sh: Zustand wird uebernommen, fortgeschrieben und ausgegeben; Erfolgs-Ping je Runde', async () => {
  const ep = await server((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    res.setHeader('content-type', 'application/json');
    // Problem besteht, und es wird in DIESEM Aufruf gemeldet.
    res.end(JSON.stringify({ fp: 'kanal:x', alerted: { problem: q.get('alertedFp') !== 'kanal:x' } }));
  });
  const hc = await server((req, res) => res.end('OK'));
  const dir = mkdtempSync(join(tmpdir(), 'kette-'));
  const aus = join(dir, 'z.json');
  const r = await lauf('bash', [SKRIPTE + 'kette.sh'], {
    BASE: ep.url, KEY: 'k', ORGS: 'tattoo-fashion', DAUER_SEK: '3', TAKT_SEK: '1',
    HC_UUID: 'uuid', HC_BASE: hc.url, ZUSTAND_AUS: aus,
    ZUSTAND: JSON.stringify({ 'tattoo-fashion': { prev: 'alt', alertedFp: 'OK', lastAlert: 0 } }),
  });
  ep.zu(); hc.zu();
  assert.equal(r.code, 0, r.out);
  const erste = new URL(ep.anfragen[0], 'http://x').searchParams;
  assert.equal(erste.get('prev'), 'alt', 'Zustand vom Vorgaenger nicht uebernommen');
  assert.equal(erste.get('org'), 'tattoo-fashion');
  const zweite = new URL(ep.anfragen[1], 'http://x').searchParams;
  assert.equal(zweite.get('alertedFp'), 'kanal:x', 'Meldung aus Runde 1 nicht im Zustand');
  const z = JSON.parse(readFileSync(aus, 'utf8'));
  assert.equal(z['tattoo-fashion'].alertedFp, 'kanal:x');
  assert.ok(z['tattoo-fashion'].lastAlert > 0);
  assert.ok(hc.anfragen.length >= 2 && hc.anfragen.every((u) => u === '/uuid'), hc.anfragen.join(','));
});

test('kette.sh: ein Aussetzer meldet nichts, zwei in Folge melden /fail', async () => {
  const hc = await server((req, res) => res.end('OK'));
  const r = await lauf('bash', [SKRIPTE + 'kette.sh'], {
    BASE: 'http://127.0.0.1:9/', KEY: 'k', DAUER_SEK: '3', TAKT_SEK: '1',
    HC_UUID: 'uuid', HC_BASE: hc.url,
  });
  hc.zu();
  assert.equal(r.code, 0, r.out);
  assert.ok(!hc.anfragen.includes('/uuid'), 'Erfolgs-Ping trotz stummem Endpoint');
  const fails = hc.anfragen.filter((u) => u === '/uuid/fail').length;
  assert.equal(fails, hc.anfragen.length - 0);
  assert.ok(fails >= 1, 'kein /fail nach zwei stummen Runden');
  // Runden = 3 (Sekunden-Takt); /fail erst ab Runde 2 -> hoechstens Runden-1.
  const runden = (r.out.match(/CURL_FAIL/g) || []).length;
  assert.equal(fails, runden - 1);
});

test('kette.sh: Zustand liegt schon VOR der ersten Runde in ZUSTAND_AUS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kette-'));
  const aus = join(dir, 'z.json');
  // Endpoint haengt nie an: BASE ungueltig, DAUER 0 -> genau eine Runde, die scheitert.
  await lauf('bash', [SKRIPTE + 'kette.sh'], {
    BASE: 'http://127.0.0.1:9/', KEY: 'k', DAUER_SEK: '0', TAKT_SEK: '1', ZUSTAND_AUS: aus,
    ZUSTAND: JSON.stringify({ 'tattoo-fashion': { prev: 'p', alertedFp: 'a', lastAlert: 5 } }),
  });
  assert.equal(JSON.parse(readFileSync(aus, 'utf8'))['tattoo-fashion'].alertedFp, 'a');
});

test('kette.sh: ohne HC_UUID Warnung, kein Ping; kaputter Zustand startet bei OK', async () => {
  const ep = await server((req, res) => res.end(JSON.stringify({ fp: 'OK' })));
  const r = await lauf('bash', [SKRIPTE + 'kette.sh'], {
    BASE: ep.url, KEY: 'k', DAUER_SEK: '1', TAKT_SEK: '1', ZUSTAND: '{kaputt', HC_UUID: '',
  });
  ep.zu();
  assert.match(r.out, /HC_UUID fehlt/);
  assert.match(r.out, /Zustand vom Vorgaenger unlesbar/);
  assert.equal(new URL(ep.anfragen[0], 'http://x').searchParams.get('prev'), 'OK');
});

// Nachgebautes gh: protokolliert Aufrufe, `run list` liefert den Inhalt von GH_LISTE.
function stubGh(dir, { dispatchExit = 0 } = {}) {
  const p = join(dir, 'gh');
  writeFileSync(p, `#!/usr/bin/env bash
echo "$*" >> "${dir}/aufrufe"
if [ "$1 $2" = "workflow run" ]; then exit ${dispatchExit}; fi
if [ "$1 $2" = "run list" ]; then cat "${dir}/liste.json"; exit 0; fi
exit 0
`);
  chmodSync(p, 0o755);
  return { PATH: `${dir}:${process.env.PATH}` };
}

test('weiter.sh: Erfolg nur, wenn ein FREMDES Dispatch-Glied wartet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'));
  const jetzt = new Date(Date.now() + 5000).toISOString();
  writeFileSync(join(dir, 'liste.json'), JSON.stringify([
    { databaseId: 111, event: 'workflow_dispatch', status: 'in_progress', createdAt: '2020-01-01T00:00:00Z' },
    { databaseId: 222, event: 'workflow_dispatch', status: 'pending', createdAt: jetzt },
  ]));
  const r = await lauf('bash', [SKRIPTE + 'weiter.sh'], {
    ...stubGh(dir), GITHUB_REPOSITORY: 'VantixAgency/tf-watchdog', GITHUB_RUN_ID: '111',
    ZUSTAND: '{"a":1}', WARTE_SEK: '0',
  });
  assert.equal(r.code, 0, r.out);
  const aufrufe = readFileSync(join(dir, 'aufrufe'), 'utf8');
  assert.match(aufrufe, /workflow run watchdog\.yml -R VantixAgency\/tf-watchdog --ref main -f zustand=\{"a":1\}/);
});

test('weiter.sh: nur der eigene Lauf sichtbar -> rot (frueher immer gruen)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'));
  writeFileSync(join(dir, 'liste.json'), JSON.stringify([
    { databaseId: 111, event: 'workflow_dispatch', status: 'in_progress', createdAt: new Date(Date.now() + 5000).toISOString() },
    { databaseId: 99, event: 'schedule', status: 'queued', createdAt: new Date(Date.now() + 5000).toISOString() },
  ]));
  const r = await lauf('bash', [SKRIPTE + 'weiter.sh'], {
    ...stubGh(dir), GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '111', WARTE_SEK: '0',
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /kein Folgeglied sichtbar/);
});

test('weiter.sh: Dispatch scheitert dreimal -> rot, nicht verschluckt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'));
  writeFileSync(join(dir, 'liste.json'), '[]');
  const r = await lauf('bash', [SKRIPTE + 'weiter.sh'], {
    ...stubGh(dir, { dispatchExit: 1 }), GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1', WARTE_SEK: '0',
  });
  assert.equal(r.code, 1);
  assert.equal(readFileSync(join(dir, 'aufrufe'), 'utf8').match(/workflow run/g).length, 3);
});

test('weiter.sh: Folgeglied 30 s VOR der Runner-Uhr angelegt zaehlt trotzdem (Uhrentoleranz)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'));
  writeFileSync(join(dir, 'liste.json'), JSON.stringify([
    { databaseId: 5, event: 'workflow_dispatch', status: 'queued', createdAt: new Date(Date.now() - 30000).toISOString().replace(/\.\d+Z$/, 'Z') },
  ]));
  const r = await lauf('bash', [SKRIPTE + 'weiter.sh'], {
    ...stubGh(dir), GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1', WARTE_SEK: '0',
  });
  assert.equal(r.code, 0, r.out);
});

test('heiler.sh: API-Fehler -> KEIN Neustart (sonst verdraengt er das wartende Glied)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'));
  const p = join(dir, 'gh');
  writeFileSync(p, `#!/usr/bin/env bash
echo "$*" >> "${dir}/aufrufe"
if [ "$1 $2" = "run list" ]; then echo "HTTP 502" >&2; exit 1; fi
exit 0
`);
  chmodSync(p, 0o755);
  const r = await lauf('bash', [SKRIPTE + 'heiler.sh'], { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', PAUSE_SEK: '0' });
  assert.equal(r.code, 0);
  assert.match(r.out, /nicht lesbar/);
  assert.doesNotMatch(readFileSync(join(dir, 'aufrufe'), 'utf8'), /workflow run/);
});

test('heiler.sh: kaputtes JSON -> KEIN Neustart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'));
  writeFileSync(join(dir, 'liste.json'), '<html>');
  const r = await lauf('bash', [SKRIPTE + 'heiler.sh'], { ...stubGh(dir), GITHUB_REPOSITORY: 'o/r', PAUSE_SEK: '0' });
  assert.equal(r.code, 0);
  assert.doesNotMatch(readFileSync(join(dir, 'aufrufe'), 'utf8'), /workflow run/);
});

test('watchdog.yml: Schritt-Timeout unter Job-Timeout, Reserve fuer das Fortsetzen', () => {
  const job = Number(kette.match(/^    timeout-minutes: (\d+)/m)[1]);
  const schritt = Number(kette.match(/^        timeout-minutes: (\d+)/m)[1]);
  assert.ok(schritt * 60 >= 20400 + 120, 'Schritt-Timeout kuerzer als Schleife + letzte Runde');
  assert.ok(job - schritt >= 5, 'zu wenig Reserve fuer weiter.sh');
});

test('heiler.sh: startet nicht, wenn ein Glied wartet; startet nach zwei leeren Pruefungen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'));
  writeFileSync(join(dir, 'liste.json'), JSON.stringify([{ status: 'queued' }]));
  let r = await lauf('bash', [SKRIPTE + 'heiler.sh'], { ...stubGh(dir), GITHUB_REPOSITORY: 'o/r', PAUSE_SEK: '0' });
  assert.equal(r.code, 0);
  assert.doesNotMatch(readFileSync(join(dir, 'aufrufe'), 'utf8'), /workflow run/);

  writeFileSync(join(dir, 'liste.json'), JSON.stringify([{ status: 'completed' }]));
  r = await lauf('bash', [SKRIPTE + 'heiler.sh'], { ...stubGh(dir), GITHUB_REPOSITORY: 'o/r', PAUSE_SEK: '0' });
  const aufrufe = readFileSync(join(dir, 'aufrufe'), 'utf8');
  assert.equal(aufrufe.match(/run list/g).length, 3, 'zweite Pruefung fehlt');
  assert.match(aufrufe, /workflow run watchdog\.yml -R o\/r --ref main -f zustand=\{\}/);
});

test('luecken-messen: Jobende -> naechster Jobstart, Ueberlappung zaehlt nicht als Luecke', async () => {
  const { luecken } = await import('../scripts/luecken-messen.mjs');
  const m = 60e3;
  const l = luecken([
    { start: 0, ende: 340 * m },
    { start: 341 * m, ende: 681 * m },      // 1 min Luecke
    { start: 600 * m, ende: 700 * m },      // ueberlappt, keine Luecke
    { start: 900 * m, ende: 1000 * m },     // 200 min Luecke
  ], 1000 * m);
  assert.deepEqual(l.map((x) => Math.round(x.min)), [1, 200]);
});

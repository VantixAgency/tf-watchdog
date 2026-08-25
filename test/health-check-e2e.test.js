// End-to-End gegen den ECHTEN Produktions-Node-Code.
//
// Luecke, die dieser Test schliesst: die Unit-Tests pruefen die Entscheidungsfunktion,
// und der Live-Lauf nach dem Deploy lief mit LEERER Problemliste durch. Damit war
// unbewiesen, ob der Node mit echten Problem-Daten ueberhaupt bis zum Senden kommt —
// ein Tippfehler im neuen Pfad haette erst beim ersten echten Ausfall gekracht, also
// genau dann, wenn der Alarm gebraucht wird.
//
// Hier laeuft der komplette Node-Code aus n8n/health-check.live.js gegen eine
// nachgebaute Supabase-REST-Schnittstelle. Geprueft wird, was am Ende herauskommt:
// send true/false — das ist genau der Wert, an dem der "Alert?"-Node Telegram und
// Mail aufhaengt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(hier, '..', 'n8n', 'health-check.live.js'), 'utf8')
  .split('\n').filter((z) => !z.startsWith('// SNAPSHOT') && !z.startsWith('// Gezogen') &&
    !z.startsWith('// (test/') && !z.startsWith('// entscheidet') && !z.startsWith('// NICHT'))
  .join('\n');

const MUC = { id: 'acc-muc', slug: 'muenchen', display_name: 'Tattoo Fashion Muenchen',
  ki_global_on: true, zernio_account_id: 'z-muc' };
// Der Node-Code benutzt Date.now() — die Testdaten muessen also relativ zur ECHTEN
// Uhr liegen, sonst faellt alles aus seinen Zeitfenstern.
const vorMin = (m) => new Date(Date.now() - m * 60000).toISOString();

// PostgREST filtert `created_at=gte.<iso>` serverseitig. Wer das im Mock weglaesst,
// testet Daten, die der Node in Wirklichkeit nie zu sehen bekommt.
function filterGte(url, rows) {
  const m = /created_at=gte\.([^&]+)/.exec(url);
  if (!m) return rows;
  const ab = Date.parse(decodeURIComponent(m[1]));
  return rows.filter((r) => Date.parse(r.created_at) >= ab);
}

// Nachbau der PostgREST-Antworten, die der Node abfragt.
function machHelpers({ chats = [], messages = [], fehlerEvents = [], repliedEvents = [] }) {
  return {
    httpRequest: async ({ url }) => {
      if (url.includes('/accounts?')) return [MUC];
      if (url.includes('type=eq.ai_replied')) return filterGte(url, repliedEvents);
      if (url.includes('ai_global_off')) return [];           // KI war nie aus
      if (url.includes('/events?')) return filterGte(url, fehlerEvents);
      if (url.includes('/messages?')) return filterGte(url, messages);
      if (url.includes('/chats?')) return chats;
      throw new Error('unerwartete Abfrage: ' + url);
    },
  };
}

// Fuehrt den Node-Code aus; staticData bleibt zwischen Laeufen erhalten (wie in n8n).
function macheRunner(daten) {
  const sd = {};
  const fn = new Function('$env', '$getWorkflowStaticData',
    'return (async function(){\n' + code + '\n}).call(this)');
  return async () => {
    const ctx = { helpers: machHelpers(daten) };
    const items = await fn.call(ctx,
      { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      () => sd);
    return items.map((i) => i.json);
  };
}

// Ein wartender Chat: eine Kundennachricht, keine Antwort danach.
const wartenderChat = (id, alterMin) => ({
  chat: { id, ai_enabled: true, ai_paused: false },
  msg: { chat_id: id, direction: 'in', source: 'customer', text: 'Hallo, habt ihr Termine?',
    attachment_url: null, created_at: vorMin(alterMin) },
});

function szenario(chats) {
  const c = chats.map((x) => wartenderChat(x.id, x.alterMin));
  return { chats: c.map((x) => x.chat), messages: c.map((x) => x.msg) };
}

test('E2E: ein Chat wartet 7 Min -> der Node sendet nichts (der Fall vom 25.08.)', async () => {
  const lauf = macheRunner(szenario([{ id: 'chat-1', alterMin: 7 }]));
  for (let i = 0; i < 5; i++) {
    const [out] = await lauf();
    assert.equal(out.send, false, `Lauf ${i} haette gesendet`);
  }
});

test('E2E: drei Chats gleichzeitig -> erster Lauf still, zweiter meldet', async () => {
  const lauf = macheRunner(szenario([
    { id: 'chat-1', alterMin: 9 }, { id: 'chat-2', alterMin: 11 }, { id: 'chat-3', alterMin: 8 },
  ]));
  const [a] = await lauf();
  assert.equal(a.send, false, 'erster Anblick muss still sein');
  const [b] = await lauf();
  assert.equal(b.send, true, 'zweiter Lauf muss melden');
  assert.equal(b.alert, true);
  assert.match(b.text, /3 Chat\(s\) ohne KI-Antwort/);
  assert.match(b.subject, /KI-Ausfall/);
});

test('E2E: ein Liegenbleiber ueber 60 Min meldet trotz Einzelfall', async () => {
  const lauf = macheRunner(szenario([{ id: 'chat-1', alterMin: 75 }]));
  await lauf();
  const [b] = await lauf();
  assert.equal(b.send, true);
  assert.match(b.text, /aeltester seit 75 Min/);
});

test('E2E: zwei wartende Chats bleiben still', async () => {
  const lauf = macheRunner(szenario([{ id: 'chat-1', alterMin: 12 }, { id: 'chat-2', alterMin: 15 }]));
  await lauf();
  const [b] = await lauf();
  assert.equal(b.send, false);
  assert.equal(b.suppressed, 1);
  assert.match(String(b.zurueckgehalten), /kein Ausfall/);
});

test('E2E: eine Fehlerhaeufung meldet, ein Einzelfehler nicht', async () => {
  const ev = (n) => Array.from({ length: n }, (_, i) => ({
    type: 'ai_replied_failed', chat_id: 'chat-' + i,
    created_at: vorMin(3), payload: { error: 'Graph API 500' } }));

  const viele = macheRunner({ ...szenario([]), fehlerEvents: ev(10) });
  await viele();
  const [b] = await viele();
  assert.equal(b.send, true, '10 Fehler muessen melden');
  assert.match(b.text, /Verarbeitungsfehler/);

  const einer = macheRunner({ ...szenario([]), fehlerEvents: ev(1) });
  await einer();
  const [c] = await einer();
  assert.equal(c.send, false, 'ein Einzelfehler darf nicht melden');
});

test('E2E: ein pausierter Chat (Uebernahme) zaehlt nicht als haengend', async () => {
  const s = szenario([{ id: 'chat-1', alterMin: 90 }]);
  s.chats[0].ai_paused = true;
  const lauf = macheRunner(s);
  await lauf();
  const [b] = await lauf();
  assert.equal(b.send, false);
});

test('E2E: ein selbstgeheilter Fehler meldet nicht', async () => {
  const lauf = macheRunner({
    ...szenario([]),
    fehlerEvents: Array.from({ length: 5 }, (_, i) => ({
      type: 'ai_replied_failed', chat_id: 'chat-' + i, created_at: vorMin(10), payload: {} })),
    repliedEvents: Array.from({ length: 5 }, (_, i) => ({
      chat_id: 'chat-' + i, created_at: vorMin(9) })),   // Retry lief danach durch
  });
  await lauf();
  const [b] = await lauf();
  assert.equal(b.send, false, 'geheilte Fehler duerfen nicht melden');
});

// Der Bug, der diesen Test ueberhaupt noetig gemacht hat: die Liegenbleiber-Regel
// (ein Chat >= 60 Min) war tot, weil der Node nur Nachrichten der letzten 30 Min lud.
// Die ausloesende Kundennachricht war da laengst aus der Abfrage gefallen. Damit waere
// die Einzelfall-Meldung ersatzlos abgeschaltet gewesen. Dieser Test haelt die beiden
// Zahlen zusammen, damit niemand nur eine davon anfasst.
test('das Ladefenster ist groesser als die Liegenbleiber-Schwelle', () => {
  const fenster = /ANSWER_FLOOR=now-(\d+)\*60\*1000/.exec(code);
  const schwelle = /dmHardMin:(\d+)/.exec(code);
  assert.ok(fenster, 'ANSWER_FLOOR im Live-Code nicht gefunden');
  assert.ok(schwelle, 'dmHardMin im Live-Code nicht gefunden');
  const fensterMin = Number(fenster[1]);
  const schwelleMin = Number(schwelle[1]);
  assert.ok(fensterMin > schwelleMin,
    `Ladefenster ${fensterMin} Min muss groesser sein als die Schwelle ${schwelleMin} Min — ` +
    'sonst meldet die Liegenbleiber-Regel nie, weil die Nachricht nie geladen wird.');
});

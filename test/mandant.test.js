// Watchdog je Mandant (Plan 2026-10-16, Task 8).
//
// Bisher galt EINE Kanalliste fuer alle Accounts einer Organisation. Ein reines
// Instagram-Studio haette damit einen WhatsApp-Kanal "gehabt", den es nie gab. Mit
// `kanaeleAusDb: true` kommt die Liste je Account aus `account_channels?active=eq.true`.
// Ohne den Schalter bleibt alles wie heute; das prueft der Paritaetsblock unten
// gegen dieselben Fixtures, die test/kanal-wirkung-e2e.test.js benutzt.
//
// Der Nachbau ist so streng wie dort: ein Join ausserhalb von `select=` gibt HTTP 400,
// und ein Embed auf `mandanten` gibt HTTP 400, solange die Fremdschluessel-Beziehung
// (Migration 0028) fehlt. Ein nachsichtiger Nachbau hat den Melder schon einmal drei
// Wochen lang unbemerkt auf "ungeprueft" gehalten.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkKanalWirkung, checkIngestion, computeFingerprint,
  ingestionZeile, kanalZeile, ladeKonfiguration,
} from "../api/check.js";
import { pruefeKonfiguration } from "../config/schema.mjs";

const BASIS = {
  kanaele: ["instagram", "whatsapp"],
  secretRefs: { datenbankUrl: "SUPABASE_URL" },
  schwellen: { wirkungFensterMin: 180, wirkungMindestEingang: 5, wirkungPausenAnteil: 70, ingestStaleStunden: 36 },
};
const ORG_ALT = { ...BASIS };
const ORG_DB = { ...BASIS, kanaeleAusDb: true };

const ACC_MUC = "acc-muc";
const ACC_INK = "acc-ink";

function antwort400() {
  return { ok: false, status: 400, json: async () => ({ code: "PGRST100" }), headers: { get: () => null } };
}

/** PostgREST-Nachbau mit serverseitigen Filtern und strenger Join-Pruefung. */
function baueFetch(db, protokoll = []) {
  return async (u) => {
    const url = String(u);
    protokoll.push(url);
    const pfad = url.split("/rest/v1/")[1] || "";
    const teile = (pfad.split("?")[1] || "").split("&");
    const select = decodeURIComponent((teile.find((t) => t.startsWith("select=")) || "").slice(7));
    if (teile.some((t) => !t.includes("="))) return antwort400();

    const param = (name) => {
      const m = pfad.match(new RegExp(`[?&]${name.replace(".", "\\.")}=([^&]*)`));
      return m ? decodeURIComponent(m[1]) : null;
    };

    if (pfad.startsWith("accounts")) {
      const willMandant = /mandanten\(/.test(select);
      if (willMandant && !db.mandantenFk) return antwort400();
      if (willMandant && !/(^|,)mandant:mandanten\(marke\)/.test(select)) return antwort400();
      const zeilen = db.accounts.map((a) => {
        const z = { id: a.id, slug: a.slug };
        if (/(^|,)display_name(,|$)/.test(select)) z.display_name = a.display_name ?? null;
        if (willMandant) {
          const m = db.mandanten.find((x) => x.id === a.mandant_id);
          z.mandant = m ? { marke: m.marke } : null;
        }
        return z;
      });
      return { ok: true, status: 200, json: async () => zeilen };
    }

    if (pfad.startsWith("account_channels")) {
      // Ohne den Filter kaemen auch abgeschaltete Kanaele zurueck. Der Nachbau
      // filtert nur, wenn die Abfrage es verlangt -- genau wie PostgREST.
      const aktiv = param("active");
      const rows = db.channels.filter((c) => (aktiv === "eq.true" ? c.active === true : true))
        .map((c) => ({ account_id: c.account_id, platform: c.platform }));
      return { ok: true, status: 200, json: async () => rows };
    }

    const filtertUeberChat = teile.some((t) => t.startsWith("chats.platform="));
    if (filtertUeberChat && !/(^|,)chats!inner\(/.test(select)) return antwort400();
    const accId = (param("account_id") || "").replace("eq.", "");
    const platform = (param("chats.platform") || param("platform") || "").replace("eq.", "");

    if (pfad.startsWith("chats")) {
      const rows = db.chats.filter((c) => c.account_id === accId && c.platform === platform);
      return { ok: true, status: 200, json: async () => rows };
    }
    if (pfad.startsWith("messages")) {
      const dir = (param("direction") || "").replace("eq.", "");
      const source = param("source") || "";
      const ab = param("created_at");
      const rows = db.messages.filter((m) => {
        if (m.account_id !== accId) return false;
        const chat = db.chats.find((c) => c.id === m.chat_id);
        if (!chat || chat.platform !== platform) return false;
        if (dir && m.direction !== dir) return false;
        if (source.startsWith("eq.") && m.source !== source.slice(3)) return false;
        if (source.startsWith("in.") && !source.slice(3).replace(/[()]/g, "").split(",").includes(m.source)) return false;
        if (ab?.startsWith("gte.") && Date.parse(m.created_at) < Date.parse(ab.slice(4))) return false;
        return true;
      });
      const h = new Map([["content-range", `0-0/${rows.length}`]]);
      return {
        ok: true, status: 200, headers: { get: (k) => h.get(k) },
        json: async () => rows.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
      };
    }
    throw new Error("unerwartete Abfrage: " + pfad);
  };
}

const vorMin = (m) => new Date(Date.now() - m * 60000).toISOString();

/** Tattoo Fashion Muenchen, beide Kanaele gesund. */
function tfGesund(db) {
  db.accounts.push({ id: ACC_MUC, slug: "muenchen", display_name: "Tattoo Fashion Muenchen", mandant_id: "m-tf" });
  db.mandanten.push({ id: "m-tf", marke: "Tattoo Fashion" });
  db.channels.push({ account_id: ACC_MUC, platform: "instagram", active: true },
                   { account_id: ACC_MUC, platform: "whatsapp", active: true });
  for (const pl of ["instagram", "whatsapp"]) {
    for (let i = 0; i < 4; i++) {
      db.chats.push({ id: `${pl}${i}`, account_id: ACC_MUC, platform: pl, ai_paused: false, ai_enabled: true, last_inbound_at: vorMin(20 + i) });
    }
    for (let i = 0; i < 8; i++) db.messages.push({ account_id: ACC_MUC, chat_id: `${pl}${i % 4}`, direction: "in", source: "customer", created_at: vorMin(20 + i) });
    for (let i = 0; i < 6; i++) db.messages.push({ account_id: ACC_MUC, chat_id: `${pl}${i % 4}`, direction: "out", source: "ai", created_at: vorMin(10 + i) });
  }
  return db;
}

/** Reines Instagram-Studio. WhatsApp ist in account_channels nur als INAKTIVE Zeile da. */
function testInk(db, { eingangVorMin = 20, kiAntworten = 6 } = {}) {
  db.accounts.push({ id: ACC_INK, slug: "test-ink", display_name: "Test-Ink Berlin", mandant_id: "m-ink" });
  db.mandanten.push({ id: "m-ink", marke: "Test-Ink" });
  db.channels.push({ account_id: ACC_INK, platform: "instagram", active: true },
                   { account_id: ACC_INK, platform: "whatsapp", active: false });
  for (let i = 0; i < 4; i++) {
    db.chats.push({ id: `ink${i}`, account_id: ACC_INK, platform: "instagram", ai_paused: false, ai_enabled: true, last_inbound_at: vorMin(eingangVorMin) });
  }
  for (let i = 0; i < 8; i++) db.messages.push({ account_id: ACC_INK, chat_id: `ink${i % 4}`, direction: "in", source: "customer", created_at: vorMin(eingangVorMin + i) });
  for (let i = 0; i < kiAntworten; i++) db.messages.push({ account_id: ACC_INK, chat_id: `ink${i % 4}`, direction: "out", source: "ai", created_at: vorMin(eingangVorMin - 5) });
  return db;
}

const leer = () => ({ accounts: [], mandanten: [], channels: [], chats: [], messages: [], mandantenFk: true });

function mitUmgebung(fn) {
  const alt = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY, fetch: globalThis.fetch };
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_SERVICE_KEY = "test-key";
  return (async () => {
    try { return await fn(); }
    finally {
      process.env.SUPABASE_URL = alt.url; process.env.SUPABASE_SERVICE_KEY = alt.key;
      globalThis.fetch = alt.fetch;
    }
  })();
}

// ---- Kanaele je Account ------------------------------------------------------

test("Mandant: reines IG-Studio Test-Ink bekommt keinen WhatsApp-Befund", async () => {
  await mitUmgebung(async () => {
    const db = testInk(tfGesund(leer()));
    const protokoll = [];
    globalThis.fetch = baueFetch(db, protokoll);
    const kw = await checkKanalWirkung(ORG_DB);
    const ing = await checkIngestion(ORG_DB);
    const alle = [...kw.geprueft, ...kw.ungeprueft, ...ing.kanaele].map((k) => k.kanal);
    assert.ok(!alle.includes("test-ink/whatsapp"), "Test-Ink hat keinen aktiven WhatsApp-Kanal: " + alle.join(","));
    assert.ok(alle.includes("test-ink/instagram"));
    assert.ok(alle.includes("muenchen/whatsapp"), "TF behaelt WhatsApp");
    assert.equal(kw.befunde.length, 0, JSON.stringify(kw.befunde));
    assert.ok(protokoll.some((u) => /account_channels\?.*active=eq\.true/.test(u)), "Kanaele muessen aus account_channels?active=eq.true kommen");
  });
});

test("Mandant: ohne Schalter bekommt Test-Ink wie heute beide Kanaele aus der Konfiguration", async () => {
  await mitUmgebung(async () => {
    const protokoll = [];
    globalThis.fetch = baueFetch(testInk(tfGesund(leer())), protokoll);
    const ing = await checkIngestion(ORG_ALT);
    assert.ok(ing.kanaele.some((k) => k.kanal === "test-ink/whatsapp"));
    assert.ok(!protokoll.some((u) => u.includes("account_channels")), "ohne Schalter keine neue Abfrage");
    assert.ok(protokoll.some((u) => u.endsWith("/rest/v1/accounts?select=id,slug")), "Accounts-Abfrage wie heute");
  });
});

test("Mandant: Studio ohne Ingestion ergibt genau einen Befund mit Test-Ink, TF ohne Befund", async () => {
  await mitUmgebung(async () => {
    // Letzte Kundennachricht bei Test-Ink vor 40 h (Schwelle 36 h).
    const db = testInk(tfGesund(leer()), { eingangVorMin: 40 * 60 });
    globalThis.fetch = baueFetch(db);
    const ing = await checkIngestion(ORG_DB);
    assert.equal(ing.tote.length, 1, JSON.stringify(ing.tote));
    assert.equal(ing.tote[0].kanal, "test-ink/instagram");
    const zeile = ingestionZeile(ing.tote[0]);
    assert.match(zeile, /Test-Ink/);
    assert.match(zeile, /Test-Ink Berlin/);
    assert.doesNotMatch(zeile, /Tattoo Fashion/);
    assert.ok(!ing.tote.some((t) => t.kanal.startsWith("muenchen/")), "TF ohne Befund");
  });
});

test("Mandant: stummer Kanal nennt Marke und Standort im Alarmtext", async () => {
  await mitUmgebung(async () => {
    globalThis.fetch = baueFetch(testInk(tfGesund(leer()), { kiAntworten: 0 }));
    const kw = await checkKanalWirkung(ORG_DB);
    assert.equal(kw.befunde.length, 1, JSON.stringify(kw.befunde));
    const zeile = kanalZeile(kw.befunde[0]);
    assert.match(zeile, /^KANAL STUMM \(Test-Ink · Test-Ink Berlin\) — test-ink\/instagram:/);
  });
});

test("Mandant: Fingerprint traegt <slug>:<befund> je totem Kanal", async () => {
  await mitUmgebung(async () => {
    globalThis.fetch = baueFetch(testInk(tfGesund(leer()), { eingangVorMin: 40 * 60, kiAntworten: 0 }));
    const ingestion = await checkIngestion(ORG_DB);
    const kanalWirkung = await checkKanalWirkung(ORG_DB);
    const fp = computeFingerprint({ ingestion, n8n: { ok: true }, kanalWirkung }, true);
    assert.match(fp, /\|ingk:test-ink\/instagram:ingestion_tot(\||$)/, fp);
    // Ein zweites totes Studio darf nicht in der Entprellung des ersten verschwinden.
    const zweites = { ...ingestion, toteFp: ingestion.toteFp + ",landshut/instagram:ingestion_tot" };
    assert.notEqual(computeFingerprint({ ingestion: zweites, n8n: { ok: true }, kanalWirkung }, true), fp);
  });
});

test("Mandant: fehlt die Beziehung zu mandanten (0028 noch nicht live), prueft der Melder trotzdem", async () => {
  // Laut Runbook laeuft der Watchdog-Deploy VOR 0028. Ein Embed ohne Fremdschluessel
  // gibt PGRST200/HTTP 400 -- ohne Rueckfall waere der Melder bis dahin blind.
  await mitUmgebung(async () => {
    const db = testInk(tfGesund(leer()), { eingangVorMin: 40 * 60 });
    db.mandantenFk = false;
    globalThis.fetch = baueFetch(db);
    const ing = await checkIngestion(ORG_DB);
    assert.notEqual(ing.ungeprueft, true, ing.note);
    assert.equal(ing.tote.length, 1);
    assert.match(ingestionZeile(ing.tote[0]), /Test-Ink Berlin/, "Standortname bleibt auch ohne Marke");
  });
});

test("Mandant: Account ohne aktive Kanalzeile faellt auf die Konfigurationsliste zurueck", async () => {
  // Fehlen TF-Zeilen in account_channels, darf WhatsApp nicht still aus der
  // Ueberwachung fallen.
  await mitUmgebung(async () => {
    const db = tfGesund(leer());
    db.channels = [];
    globalThis.fetch = baueFetch(db);
    const ing = await checkIngestion(ORG_DB);
    assert.deepEqual(ing.kanaele.map((k) => k.kanal).sort(), ["muenchen/instagram", "muenchen/whatsapp"]);
    assert.deepEqual(ing.kanalQuelleKonfig, ["muenchen"]);
  });
});

// ---- Paritaet: nur TF -> wie heute ------------------------------------------

/** Dieselbe Lage wie datenbankVorfall() in test/kanal-wirkung-e2e.test.js (17.09.2026). */
function datenbankVorfall() {
  const chats = [];
  const messages = [];
  for (let i = 0; i < 9; i++) chats.push({ id: `wa${i}`, account_id: ACC_MUC, platform: "whatsapp", ai_paused: i < 8, ai_enabled: true, last_inbound_at: vorMin(30 + i) });
  for (let i = 0; i < 17; i++) messages.push({ account_id: ACC_MUC, chat_id: `wa${i % 9}`, direction: "in", source: "customer", created_at: vorMin(20 + i) });
  for (let i = 0; i < 11; i++) messages.push({ account_id: ACC_MUC, chat_id: `wa${i % 9}`, direction: "out", source: "ig_app", created_at: vorMin(15 + i) });
  for (let i = 0; i < 4; i++) chats.push({ id: `ig${i}`, account_id: ACC_MUC, platform: "instagram", ai_paused: false, ai_enabled: true, last_inbound_at: vorMin(25 + i) });
  for (let i = 0; i < 12; i++) messages.push({ account_id: ACC_MUC, chat_id: `ig${i % 4}`, direction: "in", source: "customer", created_at: vorMin(20 + i) });
  for (let i = 0; i < 6; i++) messages.push({ account_id: ACC_MUC, chat_id: `ig${i % 4}`, direction: "out", source: "ai", created_at: vorMin(10 + i) });
  // Wie im Bestands-Fixture: kein display_name, kein Mandant.
  return {
    accounts: [{ id: ACC_MUC, slug: "muenchen" }], mandanten: [], mandantenFk: true,
    channels: [{ account_id: ACC_MUC, platform: "instagram", active: true }, { account_id: ACC_MUC, platform: "whatsapp", active: true }],
    chats, messages,
  };
}

const ohneZeit = (r) => { const { seit, ...rest } = r; return rest; };

test("Paritaet: nur TF, Vorfall 17.09. -- mit Schalter dieselbe Ausgabe wie ohne", async () => {
  await mitUmgebung(async () => {
    globalThis.fetch = baueFetch(datenbankVorfall());
    const altKw = await checkKanalWirkung(ORG_ALT);
    const altIng = await checkIngestion(ORG_ALT);
    const neuKw = await checkKanalWirkung(ORG_DB);
    const neuIng = await checkIngestion(ORG_DB);
    assert.deepEqual(ohneZeit(neuKw), ohneZeit(altKw));
    assert.deepEqual(neuIng, altIng);
    assert.equal(neuKw.befunde.length, 1);
    assert.equal(kanalZeile(neuKw.befunde[0]), `KANAL STUMM — ${altKw.befunde[0].text}`);
    const fp = (kw, ing) => computeFingerprint({ ingestion: ing, n8n: { ok: true }, kanalWirkung: kw }, true);
    assert.equal(fp(neuKw, neuIng), fp(altKw, altIng));
  });
});

test("Paritaet: ohne Schalter bleiben Alarmzeilen und Fingerprint byte-gleich", () => {
  const tot = { kanal: "muenchen/whatsapp", ageHours: 40, lastInbound: "2026-10-14T08:00:00.000Z" };
  assert.equal(ingestionZeile(tot),
    "INGESTION TOT (muenchen/whatsapp): seit 40h keine eingehende Kundennachricht (letzte 2026-10-14T08:00:00.000Z) — auf diesem Kanal kommt nichts mehr an.");
  const fp = computeFingerprint({ ingestion: { dead: true, tote: [tot] }, n8n: { ok: true } }, true);
  assert.equal(fp, "ing:true|n8n:false|exec:|reply:false|zern:false|v2:false|kanal:|blind:false");
});

// ---- Konfiguration -------------------------------------------------------------

test("Konfiguration: TF hat kanaeleAusDb, bleibt eine Organisation, Workflow-IDs eindeutig", () => {
  const k = ladeKonfiguration();
  const tf = k.organisationen.filter((o) => o.id === "tattoo-fashion");
  assert.equal(tf.length, 1);
  assert.equal(tf[0].kanaeleAusDb, true);
  const ids = k.organisationen.flatMap((o) => o.kritischeWorkflows.map((w) => w.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("Konfiguration: kanaeleAusDb muss boolesch sein", () => {
  const k = ladeKonfiguration();
  const kaputt = structuredClone(k);
  kaputt.organisationen[0].kanaeleAusDb = "ja";
  const r = pruefeKonfiguration(kaputt);
  assert.equal(r.ok, false);
  assert.ok(r.fehler.some((f) => f.includes("kanaeleAusDb")), r.fehler.join("; "));
});

// E2E-Test des Kanal-Wirkungsmelders gegen eine nachgebaute Supabase-REST-Schnittstelle.
//
// Warum zusaetzlich zu kanal-wirkung.test.js: Jene Tests pruefen die ENTSCHEIDUNG.
// Dieser prueft die DATENBESCHAFFUNG — und genau dort lag der Fehler, den der alte
// Ingestion-Check hatte. Er fragte formal korrekt ab und lieferte trotzdem ein
// wertloses Ergebnis, weil der Filter fehlte. Ein Test der Entscheidungsfunktion
// kann so etwas nie finden, weil er die Abfrage gar nicht kennt.
//
// Derselbe Gedanke steht hinter test/health-check-e2e.test.js fuer den internen Melder.

import test from "node:test";
import assert from "node:assert/strict";
import { checkKanalWirkung, checkIngestion } from "../api/check.js";

const ORG = {
  kanaele: ["instagram", "whatsapp"],
  secretRefs: { datenbankUrl: "SUPABASE_URL" },
  schwellen: { wirkungFensterMin: 180, wirkungMindestEingang: 5, wirkungPausenAnteil: 70, ingestStaleStunden: 36 },
};

/**
 * Baut ein fetch, das PostgREST nachstellt — inklusive der serverseitigen Filter.
 * `datenbank` beschreibt die Wirklichkeit, die Abfrage muss sie korrekt herausholen.
 */
function baueFetch(datenbank, protokoll = []) {
  return async (u) => {
    const url = String(u);
    protokoll.push(url);
    const pfad = url.split("/rest/v1/")[1] || "";

    if (pfad.startsWith("accounts")) {
      return { ok: true, status: 200, json: async () => datenbank.accounts };
    }

    const param = (name) => {
      const m = pfad.match(new RegExp(`[?&]${name.replace(".", "\\.")}=([^&]*)`));
      return m ? decodeURIComponent(m[1]) : null;
    };
    const accId = (param("account_id") || "").replace("eq.", "");
    const platform = (param("chats.platform") || param("platform") || "").replace("eq.", "");

    if (pfad.startsWith("chats")) {
      const rows = datenbank.chats.filter((c) => c.account_id === accId && c.platform === platform);
      return { ok: true, status: 200, json: async () => rows };
    }

    if (pfad.startsWith("messages")) {
      const dir = (param("direction") || "").replace("eq.", "");
      const source = param("source") || "";
      const rows = datenbank.messages.filter((m) => {
        if (m.account_id !== accId) return false;
        // Der springende Punkt: der Kanal kommt vom CHAT, nicht von der Nachricht.
        const chat = datenbank.chats.find((c) => c.id === m.chat_id);
        if (!chat || chat.platform !== platform) return false;
        if (dir && m.direction !== dir) return false;
        if (source.startsWith("eq.") && m.source !== source.slice(3)) return false;
        if (source.startsWith("in.")) {
          const erlaubt = source.slice(3).replace(/[()]/g, "").split(",");
          if (!erlaubt.includes(m.source)) return false;
        }
        return true;
      });
      // Zaehlung (Prefer: count=exact) vs. Zeilenabfrage
      const headers = new Map([["content-range", `0-0/${rows.length}`]]);
      return {
        ok: true, status: 200,
        headers: { get: (k) => headers.get(k) },
        json: async () => rows.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
      };
    }
    throw new Error("unerwartete Abfrage: " + pfad);
  };
}

// Nachbau des echten Zustands vom 17.09.2026, Muenchen:
//   WhatsApp: viele Eingaenge, KEINE KI-Antwort, Chats ueberwiegend pausiert
//   Instagram: laeuft
function datenbankVorfall() {
  const jetzt = Date.now();
  const vorMin = (m) => new Date(jetzt - m * 60000).toISOString();
  const chats = [];
  const messages = [];
  const MUC = "acc-muc";

  // WhatsApp: 9 Chats, 8 davon pausiert, 17 eingehende Nachrichten, 0 KI-Antworten
  for (let i = 0; i < 9; i++) {
    chats.push({ id: `wa${i}`, account_id: MUC, platform: "whatsapp",
                 ai_paused: i < 8, ai_enabled: true, last_inbound_at: vorMin(30 + i) });
  }
  for (let i = 0; i < 17; i++) {
    messages.push({ account_id: MUC, chat_id: `wa${i % 9}`, direction: "in", source: "customer",
                    created_at: vorMin(20 + i) });
  }
  for (let i = 0; i < 11; i++) {
    messages.push({ account_id: MUC, chat_id: `wa${i % 9}`, direction: "out", source: "ig_app",
                    created_at: vorMin(15 + i) });
  }

  // Instagram: laeuft normal
  for (let i = 0; i < 4; i++) {
    chats.push({ id: `ig${i}`, account_id: MUC, platform: "instagram",
                 ai_paused: false, ai_enabled: true, last_inbound_at: vorMin(25 + i) });
  }
  for (let i = 0; i < 12; i++) {
    messages.push({ account_id: MUC, chat_id: `ig${i % 4}`, direction: "in", source: "customer",
                    created_at: vorMin(20 + i) });
  }
  for (let i = 0; i < 6; i++) {
    messages.push({ account_id: MUC, chat_id: `ig${i % 4}`, direction: "out", source: "ai",
                    created_at: vorMin(10 + i) });
  }

  return { accounts: [{ id: MUC, slug: "muenchen" }], chats, messages };
}

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

test("E2E: der stumme WhatsApp-Kanal wird gemeldet, Instagram nicht", async () => {
  await mitUmgebung(async () => {
    globalThis.fetch = baueFetch(datenbankVorfall());
    const r = await checkKanalWirkung(ORG);
    assert.equal(r.ok, false);
    assert.equal(r.befunde.length, 1);
    assert.equal(r.befunde[0].kanal, "muenchen/whatsapp");
    assert.equal(r.befunde[0].art, "kanal_stumm");
    assert.equal(r.befunde[0].eingang, 17);
    assert.equal(r.befunde[0].kiAntworten, 0);
    assert.equal(r.befunde[0].manuelleAntworten, 11);
  });
});

test("E2E: der Kanal kommt aus dem Chat, nicht aus der Nachricht", async () => {
  // Der teuerste denkbare Fehler. Steht in der Nachricht faelschlich 'instagram'
  // (so verhaelt sich der Reply-Runner real), muss der Melder trotzdem richtig zaehlen.
  await mitUmgebung(async () => {
    const db = datenbankVorfall();
    // Alle Nachrichten tragen die falsche Kanalspalte — der Join muss das ueberstimmen.
    db.messages.forEach((m) => { m.platform = "instagram"; });
    globalThis.fetch = baueFetch(db);
    const r = await checkKanalWirkung(ORG);
    const wa = r.geprueft.find((g) => g.kanal === "muenchen/whatsapp");
    assert.equal(wa.eingang, 17, "WhatsApp-Eingaenge muessen ueber den Chat-Join gefunden werden");
  });
});

test("E2E: pausierte Chats werden mitgezaehlt, nicht weggefiltert", async () => {
  await mitUmgebung(async () => {
    globalThis.fetch = baueFetch(datenbankVorfall());
    const r = await checkKanalWirkung(ORG);
    const wa = r.geprueft.find((g) => g.kanal === "muenchen/whatsapp");
    assert.equal(wa.chatsMitEingang, 9);
    assert.equal(wa.davonPausiert, 8);
  });
});

test("E2E: ein Chat mit ai_enabled=false zaehlt wie pausiert", async () => {
  await mitUmgebung(async () => {
    const db = datenbankVorfall();
    db.chats.filter((c) => c.platform === "whatsapp").forEach((c) => { c.ai_paused = false; c.ai_enabled = false; });
    globalThis.fetch = baueFetch(db);
    const r = await checkKanalWirkung(ORG);
    const wa = r.geprueft.find((g) => g.kanal === "muenchen/whatsapp");
    assert.equal(wa.davonPausiert, 9);
  });
});

test("E2E: ein gesunder Betrieb erzeugt keinen Befund", async () => {
  await mitUmgebung(async () => {
    const db = datenbankVorfall();
    // WhatsApp bekommt KI-Antworten und weniger Pausen.
    db.chats.filter((c) => c.platform === "whatsapp").forEach((c) => { c.ai_paused = false; });
    for (let i = 0; i < 7; i++) {
      db.messages.push({ account_id: "acc-muc", chat_id: `wa${i}`, direction: "out", source: "ai",
                         created_at: new Date().toISOString() });
    }
    globalThis.fetch = baueFetch(db);
    const r = await checkKanalWirkung(ORG);
    assert.equal(r.ok, true, JSON.stringify(r.befunde));
  });
});

test("E2E: jede Abfrage filtert auf Studio UND Kanal", async () => {
  await mitUmgebung(async () => {
    const protokoll = [];
    globalThis.fetch = baueFetch(datenbankVorfall(), protokoll);
    await checkKanalWirkung(ORG);
    const zaehlungen = protokoll.filter((u) => u.includes("/messages?"));
    assert.ok(zaehlungen.length >= 6, "pro Kanal drei Zaehlungen erwartet");
    for (const u of zaehlungen) {
      assert.match(u, /account_id=eq\./, "ohne Studiofilter waere es ein Cross-Tenant-Lesen");
      assert.match(u, /chats!inner\(platform\)/);
    }
  });
});

// ---- Ingestion je Kanal ------------------------------------------------------

test("E2E Ingestion: ein toter Kanal wird gemeldet, obwohl der andere laeuft", async () => {
  // Der Kern des alten Fehlers: EINE globale Abfrage. Solange Instagram lief, war
  // der Melder gruen — auch bei wochenlang totem WhatsApp.
  await mitUmgebung(async () => {
    const db = datenbankVorfall();
    const lange = new Date(Date.now() - 40 * 3600 * 1000).toISOString();
    db.messages.filter((m) => String(m.chat_id).startsWith("wa")).forEach((m) => { m.created_at = lange; });
    globalThis.fetch = baueFetch(db);
    const r = await checkIngestion(ORG);
    assert.equal(r.ok, false);
    assert.equal(r.tote.length, 1);
    assert.equal(r.tote[0].kanal, "muenchen/whatsapp");
  });
});

test("E2E Ingestion: laufen beide Kanaele, ist nichts tot", async () => {
  await mitUmgebung(async () => {
    globalThis.fetch = baueFetch(datenbankVorfall());
    const r = await checkIngestion(ORG);
    assert.equal(r.ok, true);
    assert.equal(r.tote.length, 0);
    assert.equal(r.kanaele.length, 2);
  });
});

test("E2E Ingestion: ein Kanal ohne jede Nachricht ist neu, nicht tot", async () => {
  await mitUmgebung(async () => {
    const db = datenbankVorfall();
    db.messages = db.messages.filter((m) => !String(m.chat_id).startsWith("wa"));
    db.chats = db.chats.filter((c) => c.platform !== "whatsapp");
    globalThis.fetch = baueFetch(db);
    const r = await checkIngestion(ORG);
    assert.equal(r.ok, true, "ein noch nie benutzter Kanal darf kein Dauerfehlalarm sein");
    assert.ok(r.kanaele.some((k) => k.nieEmpfangen === true));
  });
});

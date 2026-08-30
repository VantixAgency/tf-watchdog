// Tests für den Zernio-Webhook-Check.
//
// Warum es diesen Check gibt: Im Juni war die Ingestion 13 Tage tot, weil Zernio
// den Webhook nach 20 Fehlzustellungen AUTO-DEAKTIVIERT hatte (isActive:false,
// disabledReason:auto:consecutive_failures). Von außen sah das aus wie Stille —
// erkennbar erst über den Umweg "seit X Stunden keine DM". Zernio sagt es aber
// direkt, wenn man fragt. Das ist kein Rückschluss mehr, sondern eine Auskunft.
//
// Die Payloads unten sind der echten API-Antwort nachgebaut (Stand 11.08.2026).

import test from "node:test";
import assert from "node:assert/strict";
import { zernioVerdict as _zernioVerdict } from "../api/check.js";

// G4: Der Webhook-Match ist Konfiguration, kein Default im Produktkern.
// Die Tests uebergeben ihn deshalb ausdruecklich -- so dokumentieren sie, dass ein
// zweiter Mandant seinen eigenen Match mitbringt.
const TF_MATCH = "tattoo-fashion-zernio-ingest";
const zernioVerdict = (payload, opts = {}) => _zernioVerdict(payload, { match: TF_MATCH, ...opts });

const TF_URL = "https://n8n.dimi-it.com/webhook/tattoo-fashion-zernio-ingest";

const gesund = {
  webhooks: [
    {
      name: "Tattoo Fashion n8n Inbox",
      url: TF_URL,
      events: ["message.received", "message.sent"],
      isActive: true,
      failureCount: 0,
      lastFiredAt: "2026-08-11T09:26:47.277Z",
      disabledAt: null,
      disabledReason: null,
      _id: "6a0d5186b3590edee9c77268",
    },
    // Fremder Webhook (SAM/Niki) — steht im selben Workspace und ist tot.
    // Darf den TF-Alarm NIEMALS auslösen.
    {
      name: "SAM Production",
      url: "https://staging.callsam.io/api/zernio/webhook",
      isActive: false,
      failureCount: 2,
      disabledReason: "auto:sustained_failure",
    },
  ],
};

test("gesunder Webhook ist ok, fremde tote Webhooks stören nicht", () => {
  const v = zernioVerdict(gesund);
  assert.equal(v.ok, true);
  assert.equal(v.found, true);
  assert.equal(v.isActive, true);
  assert.deepEqual(v.problems, []);
});

test("der Juni-Ausfall wird direkt gemeldet", () => {
  const v = zernioVerdict({
    webhooks: [
      {
        name: "Tattoo Fashion n8n Inbox",
        url: TF_URL,
        isActive: false,
        failureCount: 20,
        disabledAt: "2026-06-28T00:00:00.000Z",
        disabledReason: "auto:consecutive_failures",
      },
    ],
  });
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /deaktiviert/i);
  assert.match(v.problems[0], /auto:consecutive_failures/);
});

test("scheiternde Zustellungen alarmieren, BEVOR Zernio abschaltet", () => {
  // SAM lief 8 Tage auf Fehlern, ehe Zernio abschaltete. Diese Vorwarnzeit
  // will der Check nutzen, statt auf die Abschaltung zu warten.
  const v = zernioVerdict({
    webhooks: [{ name: "TF", url: TF_URL, isActive: true, failureCount: 3 }],
  });
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /Zustellungen scheitern/i);
});

test("vereinzelter Fehler ist noch kein Alarm", () => {
  const v = zernioVerdict({
    webhooks: [{ name: "TF", url: TF_URL, isActive: true, failureCount: 1 }],
  });
  assert.equal(v.ok, true);
});

test("verschwundener Webhook ist ein Problem", () => {
  // Real vorgekommen: Landshut hatte zernio_webhook_id = NULL.
  const v = zernioVerdict({ webhooks: [gesund.webhooks[1]] });
  assert.equal(v.ok, false);
  assert.equal(v.found, false);
  assert.match(v.problems[0], /nicht registriert/i);
});

test("unerwartete Antwort alarmiert NICHT, sondern meldet sich als Notiz", () => {
  // Ein Monitor, der bei jeder API-Änderung Fehlalarm schlägt, wird ignoriert.
  for (const payload of [null, {}, { webhooks: "kaputt" }]) {
    const v = zernioVerdict(payload);
    assert.equal(v.ok, true, `unerwartet Alarm bei ${JSON.stringify(payload)}`);
    assert.ok(v.note, "Notiz fehlt");
  }
});

test("das Webhook-Secret taucht in der Ausgabe nicht auf", () => {
  const v = zernioVerdict({
    webhooks: [{ name: "TF", url: TF_URL, isActive: true, failureCount: 0, secret: "geheim123" }],
  });
  assert.ok(!JSON.stringify(v).includes("geheim123"));
});

test("ein übersprungener Zernio-Check macht den Fingerprint nicht zum Problem", async () => {
  // checkZernio() liefert ohne API-Key {skipped:true} — ganz OHNE ok-Feld.
  // Naiv als !zernio.ok gelesen, sähe das aus wie ein Ausfall.
  const { computeFingerprint } = await import("../api/check.js");
  const fp = computeFingerprint({ n8n: { ok: true }, zernio: { skipped: true } }, true);
  assert.match(fp, /zern:false/);
});

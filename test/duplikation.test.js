// G4 — Duplikations- und Konfigurationstests.
//
// Beweist, dass der Watchdog eine zweite Organisation ueberwachen kann, ohne dass
// Alarme, Workflows oder Daten uebergreifen. Vorher trug er vier Workflow-IDs,
// einen Match-String und die Empfaenger fest im Code -- ein zweiter Mandant waere
// unueberwacht geblieben.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pruefeKonfiguration, pruefeOrganisation, mitVorgaben, GRENZEN, PRUEFUNGEN } from "../config/schema.mjs";
import { ladeKonfiguration, workflowIndex, zernioVerdict } from "../api/check.js";

const HIER = dirname(fileURLToPath(import.meta.url));
const echteKonfig = JSON.parse(readFileSync(join(HIER, "..", "config", "installationen.json"), "utf8"));

/** Zweite, rein synthetische Organisation. Bewusst gegensaetzlich konfiguriert. */
const ZWEITE = {
  id: "muster-studio",
  anzeigename: "Muster Studio (synthetisch)",
  kritischeWorkflows: [
    { id: "ZZZZ111111111111", bezeichnung: "Muster-Poll" },
    { id: "ZZZZ222222222222", bezeichnung: "Muster-Runner" },
  ],
  pruefungen: ["n8n_erreichbar", "workflow_fehler", "provider_webhook"],
  provider: { art: "zernio", webhookMatch: "muster-studio-ingest" },
  alarm: {
    betreffProblem: "Muster Studio: PROBLEM",
    betreffOk: "Muster Studio: wieder OK",
    absender: "Muster Watchdog <noreply@example.org>",
    email: ["betrieb@example.org"],
    telegramChatIds: ["-1001234567890"],
  },
  schwellen: { fehlerSchwelle: 2, stauHartMin: 90 },
  secretRefs: { n8nApiKey: "MUSTER_N8N_API_KEY", providerApiKey: "MUSTER_PROVIDER_KEY" },
};

// ─── Konfigurationsvalidierung ───────────────────────────────────────────────

test("die echte Tattoo-Fashion-Konfiguration ist gueltig", () => {
  const r = pruefeKonfiguration(echteKonfig);
  assert.equal(r.ok, true, `Fehler: ${r.fehler.join(" | ")}`);
});

test("die zweite synthetische Organisation ist gueltig", () => {
  const r = pruefeOrganisation(ZWEITE);
  assert.equal(r.ok, true, `Fehler: ${r.fehler.join(" | ")}`);
});

test("beide Organisationen zusammen sind gueltig", () => {
  const r = pruefeKonfiguration({ organisationen: [...echteKonfig.organisationen, ZWEITE] });
  assert.equal(r.ok, true, `Fehler: ${r.fehler.join(" | ")}`);
});

test("Organisation ohne kritische Workflows wird abgelehnt", () => {
  const r = pruefeOrganisation({ ...ZWEITE, kritischeWorkflows: [] });
  assert.equal(r.ok, false);
  assert.match(r.fehler.join(" "), /unueberwacht/);
});

test("Organisation ohne Alarmempfaenger wird abgelehnt", () => {
  const r = pruefeOrganisation({ ...ZWEITE, alarm: { ...ZWEITE.alarm, email: [], telegramChatIds: [] } });
  assert.equal(r.ok, false);
  assert.match(r.fehler.join(" "), /Empfaenger/);
});

test("unbekannte Pruefung wird abgelehnt", () => {
  const r = pruefeOrganisation({ ...ZWEITE, pruefungen: ["n8n_erreichbar", "kaffee_kochen"] });
  assert.equal(r.ok, false);
  assert.match(r.fehler.join(" "), /kaffee_kochen/);
});

test("Schwellwert ausserhalb der Grenzen wird abgelehnt", () => {
  const r = pruefeOrganisation({ ...ZWEITE, schwellen: { stauHartMin: GRENZEN.stauHartMin.max + 1 } });
  assert.equal(r.ok, false);
  assert.match(r.fehler.join(" "), /ausserhalb/);
});

test("ein SECRET-WERT statt eines Variablennamens wird abgelehnt", () => {
  // Schutz gegen genau den Fehler, der zum Incident vom 30.08. gefuehrt hat:
  // Klartext-Secrets in Konfiguration statt Referenzen.
  const r = pruefeOrganisation({ ...ZWEITE, secretRefs: { n8nApiKey: "eyJhbGciOiJIUzI1NiJ9.abc.def" } });
  assert.equal(r.ok, false);
  assert.match(r.fehler.join(" "), /Umgebungsvariablen-NAME/);
});

test("doppelte Organisations-ID wird abgelehnt", () => {
  const r = pruefeKonfiguration({ organisationen: [ZWEITE, { ...ZWEITE, anzeigename: "Kopie" }] });
  assert.equal(r.ok, false);
  assert.match(r.fehler.join(" "), /mehrfach/);
});

// ─── Cross-Tenant-Schutz ─────────────────────────────────────────────────────

test("CROSS-TENANT: dieselbe Workflow-ID in zwei Organisationen wird abgelehnt", () => {
  const geklaut = { ...ZWEITE, kritischeWorkflows: echteKonfig.organisationen[0].kritischeWorkflows };
  const r = pruefeKonfiguration({ organisationen: [...echteKonfig.organisationen, geklaut] });
  assert.equal(r.ok, false);
  assert.match(r.fehler.join(" "), /Cross-Tenant-Alarm moeglich/);
});

test("CROSS-TENANT: der Workflow-Index einer Organisation kennt die fremden IDs nicht", () => {
  const tf = workflowIndex(echteKonfig.organisationen[0]);
  const zw = workflowIndex(ZWEITE);
  for (const id of Object.keys(tf)) assert.equal(zw[id], undefined, `${id} ist bei der zweiten Org sichtbar`);
  for (const id of Object.keys(zw)) assert.equal(tf[id], undefined, `${id} ist bei Tattoo Fashion sichtbar`);
  assert.ok(Object.keys(tf).length >= 4);
  assert.equal(Object.keys(zw).length, 2);
});

test("CROSS-TENANT: Fehler fremder Workflows zaehlen nicht fuer die eigene Organisation", () => {
  // Nachbau der Zaehllogik aus checkExecutionErrors: nur eigene IDs zaehlen.
  const zaehle = (org, ausfuehrungen) => {
    const kritisch = workflowIndex(org);
    const c = {};
    for (const e of ausfuehrungen) if (kritisch[e.workflowId]) c[e.workflowId] = (c[e.workflowId] || 0) + 1;
    return c;
  };
  const tfWf = echteKonfig.organisationen[0].kritischeWorkflows[0].id;
  const ausfuehrungen = [
    { workflowId: tfWf }, { workflowId: tfWf }, { workflowId: tfWf }, { workflowId: tfWf },
    { workflowId: "FREMD9999999999" },
  ];
  assert.equal(Object.keys(zaehle(ZWEITE, ausfuehrungen)).length, 0,
    "Die zweite Organisation darf Tattoo-Fashion-Fehler nicht sehen");
  assert.equal(zaehle(echteKonfig.organisationen[0], ausfuehrungen)[tfWf], 4);
});

test("CROSS-TENANT: Alarmempfaenger ueberschneiden sich nicht", () => {
  const tf = echteKonfig.organisationen[0].alarm;
  const a = new Set([...(tf.email ?? []), ...(tf.telegramChatIds ?? []).map(String)]);
  const b = new Set([...(ZWEITE.alarm.email ?? []), ...(ZWEITE.alarm.telegramChatIds ?? []).map(String)]);
  for (const x of b) assert.equal(a.has(x), false, `Empfaenger ${x} bekaeme Alarme beider Organisationen`);
});

test("CROSS-TENANT: der Provider-Match ist organisationseigen", () => {
  const tfMatch = echteKonfig.organisationen[0].provider.webhookMatch;
  assert.notEqual(tfMatch, ZWEITE.provider.webhookMatch);
  // Der Webhook der einen Organisation darf die andere nicht als "gesund" erscheinen lassen.
  const payload = { webhooks: [{ name: "TF", url: `https://example.org/webhook/${tfMatch}`, isActive: true, failureCount: 0 }] };
  const fuerZweite = zernioVerdict(payload, { match: ZWEITE.provider.webhookMatch });
  assert.equal(fuerZweite.found, false, "Der fremde Webhook wurde faelschlich als eigener erkannt");
  const fuerTf = zernioVerdict(payload, { match: tfMatch });
  assert.equal(fuerTf.found, true);
});

test("ohne konfigurierten Match wird NICHT geraten", () => {
  const v = zernioVerdict({ webhooks: [] }, {});
  assert.equal(v.skipped, true, "Ein Melder ohne Match darf keine Gesundheit behaupten");
  assert.match(v.reason, /kein webhookMatch/);
});

// ─── Vorgaben und Laden ──────────────────────────────────────────────────────

test("fehlende Schwellwerte werden mit den Vorgaben gefuellt", () => {
  const org = mitVorgaben(ZWEITE);
  assert.equal(org.schwellen.fehlerSchwelle, 2, "gesetzter Wert darf nicht ueberschrieben werden");
  assert.equal(org.schwellen.ingestStaleStunden, GRENZEN.ingestStaleStunden.default);
  assert.equal(ZWEITE.schwellen.ingestStaleStunden, undefined, "Eingabe wurde veraendert");
});

test("ladeKonfiguration validiert und wirft bei ungueltiger Konfiguration", () => {
  const cfg = ladeKonfiguration();
  assert.ok(Array.isArray(cfg.organisationen) && cfg.organisationen.length >= 1);
  assert.equal(typeof cfg.organisationen[0].schwellen.fehlerFensterMin, "number");
  assert.throws(() => ladeKonfiguration(join(HIER, "fixtures", "gibt-es-nicht.json")));
});

test("jede erlaubte Pruefung ist dokumentiert und eindeutig", () => {
  assert.equal(new Set(PRUEFUNGEN).size, PRUEFUNGEN.length);
  for (const p of echteKonfig.organisationen[0].pruefungen) assert.ok(PRUEFUNGEN.includes(p));
});

test("die echte Konfiguration enthaelt keine Secret-WERTE", () => {
  const roh = JSON.stringify(echteKonfig);
  assert.equal(/eyJ[A-Za-z0-9_-]{10,}\./.test(roh), false, "JWT in der Konfiguration");
  assert.equal(/sk-[A-Za-z0-9_-]{20,}/.test(roh), false, "sk-Key in der Konfiguration");
  assert.equal(/bot\d{6,}:/.test(roh), false, "Telegram-Token in der Konfiguration");
  for (const org of echteKonfig.organisationen)
    for (const v of Object.values(org.secretRefs ?? {}))
      assert.match(String(v), /^[A-Z][A-Z0-9_]{2,60}$/, `secretRefs enthaelt keinen Variablennamen: ${v}`);
});

test("CROSS-TENANT: jede Organisation nennt eigene Secret-Referenzen fuer die Datenbank", () => {
  // Ohne eigene Referenzen laese der Melder der einen Organisation in der Datenbank
  // der anderen. Die Referenzen muessen sich unterscheiden.
  const tf = echteKonfig.organisationen[0].secretRefs ?? {};
  const zw = ZWEITE.secretRefs ?? {};
  for (const feld of ["n8nApiKey", "providerApiKey"]) {
    assert.ok(tf[feld], `Tattoo Fashion ohne secretRefs.${feld}`);
    assert.ok(zw[feld], `Zweite Organisation ohne secretRefs.${feld}`);
    assert.notEqual(tf[feld], zw[feld],
      `Beide Organisationen nutzen dieselbe Variable ${feld} — Cross-Tenant-Zugriff`);
  }
});

test("der n8n-Host ist organisationseigen und muss https sein", () => {
  assert.ok(echteKonfig.organisationen[0].n8nUrl, "Tattoo Fashion ohne n8nUrl");
  const r = pruefeOrganisation({ ...ZWEITE, n8nUrl: "http://unsicher.example.org" });
  assert.equal(r.ok, false, "http darf nicht durchgehen");
  assert.match(r.fehler.join(" "), /https-URL/);
});

// Tests für die Reply-Gap-Alarmregel.
//
// Hintergrund (11.08.2026): Nachdem das Werktags-Blindloch geschlossen war, meldete
// der Watchdog sofort einen EINZELNEN Chat, der 25 Min auf eine KI-Antwort wartete.
// Das ist die falsche Flughöhe: Ein externer Monitor soll SYSTEMAUSFÄLLE melden.
// Einzelne Chats deckt der interne n8n-Monitor ab (ab 7 Min) und das Dashboard.
// Dazu kommt: Übernimmt das Studio einen Chat von Hand, wird das erst erkannt, wenn
// der Mensch tatsächlich antwortet — bis dahin sieht der Chat aus wie "hängt".
//
// Neue Regel, ohne jede Uhrzeit-Annahme:
//   Alarm, wenn MEHRERE Chats gleichzeitig hängen (Stau = Ausfall)
//   oder EINER so lange liegt, dass er unabhängig von der Ursache liegen geblieben ist.

import test from "node:test";
import assert from "node:assert/strict";
import { replyGapVerdict } from "../api/check.js";

const chat = (inboundAgeMin, account = "muenchen") => ({
  chat: "abc12345",
  account,
  inboundAgeMin,
});

test("ein einzelner Chat kurz über der Sammelschwelle alarmiert NICHT", () => {
  // Genau der Fall vom 11.08.2026, der die Beschwerde ausgelöst hat.
  const v = replyGapVerdict([chat(26)]);
  assert.equal(v.stalledReply, false);
  assert.equal(v.stuckCount, 1);
  assert.equal(v.oldestStuckMin, 26);
});

test("ein einzelner Chat über einer Stunde alarmiert doch", () => {
  // "Hauptsache es bleiben keine DMs liegen" — ab hier liegt er, egal warum.
  const v = replyGapVerdict([chat(61)]);
  assert.equal(v.stalledReply, true);
});

test("die Stundengrenze selbst zählt schon als liegen geblieben", () => {
  assert.equal(replyGapVerdict([chat(60)]).stalledReply, true);
  assert.equal(replyGapVerdict([chat(59)]).stalledReply, false);
});

test("zwei gleichzeitig hängende Chats sind ein Stau und alarmieren", () => {
  const v = replyGapVerdict([chat(26), chat(31, "landshut")]);
  assert.equal(v.stalledReply, true);
  assert.equal(v.stuckCount, 2);
  assert.equal(v.oldestStuckMin, 31);
});

test("nichts hängt, nichts wird gemeldet", () => {
  const v = replyGapVerdict([]);
  assert.equal(v.stalledReply, false);
  assert.equal(v.stuckCount, 0);
  assert.equal(v.oldestStuckMin, 0);
});

test("die Schwellen sind einstellbar", () => {
  const v = replyGapVerdict([chat(26)], { minCount: 1 });
  assert.equal(v.stalledReply, true);
  assert.equal(replyGapVerdict([chat(45)], { hardMin: 40 }).stalledReply, true);
});

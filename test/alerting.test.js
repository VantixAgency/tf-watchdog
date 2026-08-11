// Tests für die Alarm-Entscheidung.
//
// Zwei Regeln, beide aus echtem Ärger entstanden:
//
// 1) PERSISTENZ (11.08.2026): Bisher mailte der erste Ping, der irgendein Problem
//    sah. Alles Flüchtige — ein n8n-Aussetzer, ein Wackler beim Deploy, ein Chat,
//    der gerade beantwortet wird — landete sofort im Postfach und war beim Lesen
//    längst vorbei. Ein Problem muss jetzt ZWEIMAL hintereinander gesehen werden.
//
// 2) KEINE ENTWARNUNG FÜR NIE GEMELDETES: Vorher hing die Entwarnung am zuletzt
//    gesehenen Zustand (prev). Ein Problem, das niemand gemeldet bekam, erzeugte
//    trotzdem eine "wieder OK"-Mail — also eine Meldung über etwas, von dem der
//    Empfänger nie erfahren hatte. Sie hängt jetzt daran, ob wirklich gemailt wurde.

import test from "node:test";
import assert from "node:assert/strict";
import { decideAlert } from "../api/check.js";

const OK = "OK";
const PROBLEM = "ing:false|n8n:false|exec:|reply:true|zern:false";
const REMIND = 7200;

// Kurzschreibweise mit den Defaults, wie der Aufrufer sie schickt.
const entscheide = (over) =>
  decideAlert({
    hasProblems: true,
    fp: PROBLEM,
    prev: PROBLEM,
    alertedFp: OK,
    sinceAlert: 60,
    remind: REMIND,
    notifyOff: false,
    ...over,
  });

test("das erste Auftauchen eines Problems mailt noch nicht", () => {
  assert.equal(entscheide({ prev: OK }), "none");
});

test("beim zweiten Mal hintereinander wird gemeldet", () => {
  assert.equal(entscheide({ prev: PROBLEM, alertedFp: OK }), "problem");
});

test("dasselbe gemeldete Problem wiederholt sich nicht sofort", () => {
  assert.equal(entscheide({ alertedFp: PROBLEM, sinceAlert: 600 }), "none");
});

test("nach dem Erinnerungsintervall meldet sich ein anhaltendes Problem erneut", () => {
  assert.equal(entscheide({ alertedFp: PROBLEM, sinceAlert: REMIND + 1 }), "problem");
});

test("ein Problemwechsel braucht ebenfalls erst eine Bestätigung", () => {
  const anderes = "ing:true|n8n:false|exec:|reply:false|zern:false";
  assert.equal(entscheide({ fp: anderes, prev: PROBLEM, alertedFp: PROBLEM }), "none");
  assert.equal(entscheide({ fp: anderes, prev: anderes, alertedFp: PROBLEM }), "problem");
});

test("Entwarnung nur, wenn vorher wirklich gemeldet wurde", () => {
  assert.equal(entscheide({ hasProblems: false, alertedFp: PROBLEM }), "resolved");
});

test("ein flüchtiges Problem erzeugt WEDER Alarm NOCH Entwarnung", () => {
  // Der ganze Sinn der Übung: einmal gesehen, dann weg — Postfach bleibt leer.
  assert.equal(entscheide({ prev: OK }), "none");
  assert.equal(entscheide({ hasProblems: false, prev: PROBLEM, alertedFp: OK }), "none");
});

test("Hard-Mute schweigt in jedem Fall", () => {
  assert.equal(entscheide({ notifyOff: true }), "none");
  assert.equal(entscheide({ hasProblems: false, alertedFp: PROBLEM, notifyOff: true }), "none");
});

test("ein altes Kettenglied ohne alertedFp meldet weiter, aber ohne Flut", () => {
  // Während des Rollouts läuft noch der alte Workflow, der alertedFp nicht mitschickt.
  // Dort steht last_alert=0, sinceAlert ist also riesig — die Erinnerungsregel trägt
  // die Meldung. Danach greift die Entprellung wie gehabt.
  assert.equal(entscheide({ alertedFp: undefined, prev: PROBLEM, sinceAlert: 1.8e9 }), "problem");
  assert.equal(entscheide({ alertedFp: undefined, prev: PROBLEM, sinceAlert: 600 }), "none");
  assert.equal(entscheide({ alertedFp: undefined, prev: OK, sinceAlert: 1.8e9 }), "none");
});

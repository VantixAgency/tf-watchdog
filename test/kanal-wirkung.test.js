// Tests fuer den Kanal-Wirkungsmelder.
//
// Der Massstab dieser Tests ist nicht "die Funktion tut, was ich geschrieben habe",
// sondern: HAETTE SIE DEN VORFALL VOM 17.09.2026 GEMELDET? Die Zahlen unten sind
// deshalb keine ausgedachten Fixtures, sondern am 17.09.2026 aus der Live-Datenbank
// gemessen (n8n-Webhook `tf-stats-engine`, Zeitblock Berlin 10-14 Uhr).

import test from "node:test";
import assert from "node:assert/strict";
import { kanalWirkungVerdict, kanalQueries, WIRKUNG_VORGABEN } from "../api/kanal-wirkung.mjs";

// ---- Der echte Vorfall -------------------------------------------------------

// Gemessen 17.09.2026, Berlin 10-14 Uhr, Account Muenchen:
//   WhatsApp   17 Eingaenge /  0 KI-Antworten / 11 manuell
//   Instagram   2 Eingaenge /  1 KI-Antwort
const VORFALL = [
  { studio: "muenchen", kanal: "whatsapp", eingang: 17, kiAntworten: 0, manuelleAntworten: 11,
    chatsMitEingang: 9, davonPausiert: 8 },
  { studio: "muenchen", kanal: "instagram", eingang: 2, kiAntworten: 1, manuelleAntworten: 0,
    chatsMitEingang: 2, davonPausiert: 0 },
];

test("der Vorfall vom 17.09.2026 wird gemeldet", () => {
  const v = kanalWirkungVerdict(VORFALL);
  assert.equal(v.ok, false, "17 Eingaenge ohne eine einzige KI-Antwort muessen alarmieren");
  assert.equal(v.befunde.length, 1);
  assert.equal(v.befunde[0].kanal, "muenchen/whatsapp");
  assert.equal(v.befunde[0].art, "kanal_stumm");
});

test("der gesunde Kanal desselben Studios loest KEINEN Alarm aus", () => {
  // Genau das ist der Grund, warum getrennt je Kanal geprueft wird: Instagram lief
  // an dem Tag. Ein gemeinsamer Melder haette das als "das System antwortet ja" gelesen.
  const v = kanalWirkungVerdict(VORFALL);
  assert.ok(!v.befunde.some((b) => b.kanal === "muenchen/instagram"));
  // Instagram hatte nur 2 Eingaenge -> es wird gar nicht geurteilt, und das steht auch so da.
  assert.ok(v.ungeprueft.some((u) => u.kanal === "muenchen/instagram"));
});

test("der Befundtext nennt Zahlen, nicht Stimmung", () => {
  const b = kanalWirkungVerdict(VORFALL).befunde[0];
  assert.match(b.text, /17 Kundennachrichten/);
  assert.match(b.text, /0 von der KI beantwortet/);
  assert.match(b.text, /11 von Hand/);
});

// ---- Flughoehe: keine Meldungen von Nicht-Ausfaellen --------------------------

test("ein ruhiger Kanal ohne Verkehr meldet nichts", () => {
  const v = kanalWirkungVerdict([
    { studio: "landshut", kanal: "whatsapp", eingang: 0, kiAntworten: 0, manuelleAntworten: 0,
      chatsMitEingang: 0, davonPausiert: 0 },
  ]);
  assert.equal(v.ok, true);
});

test("wenige Eingaenge ohne KI-Antwort sind KEIN Alarm, gelten aber als ungeprueft", () => {
  // 16.09.2026, Muenchen WhatsApp: 5 Eingaenge ueber den ganzen Tag verteilt, in
  // keinem 3h-Fenster genug fuer ein Urteil. Ein Melder, der hier schreit, wird
  // abgeschaltet — und ist dann beim naechsten echten Ausfall auch aus.
  const v = kanalWirkungVerdict([
    { studio: "muenchen", kanal: "whatsapp", eingang: 4, kiAntworten: 0, manuelleAntworten: 3,
      chatsMitEingang: 3, davonPausiert: 3 },
  ]);
  assert.equal(v.ok, true, "unter der Mindestmenge wird nicht geurteilt");
  assert.equal(v.befunde.length, 0);
  assert.equal(v.ungeprueft.length, 1);
  assert.match(v.ungeprueft[0].grund, /nur 4 Eingaenge/);
});

test("Stille wird nie als Gesundheit ausgegeben", () => {
  // Der Kern des Vorfalls: Ein Melder, der ungeprueftes als "ok" verbucht, ist der
  // Melder, der 272-mal gruen war. Ungeprueftes muss sichtbar bleiben.
  const v = kanalWirkungVerdict([
    { studio: "muenchen", kanal: "whatsapp", eingang: 1, kiAntworten: 0, manuelleAntworten: 0,
      chatsMitEingang: 1, davonPausiert: 1 },
  ]);
  assert.equal(v.geprueft.length, 0);
  assert.equal(v.ungeprueft.length, 1);
});

test("genau an der Mindestmenge wird geurteilt", () => {
  const knapp = [{ studio: "muenchen", kanal: "whatsapp", eingang: WIRKUNG_VORGABEN.mindestEingang,
                   kiAntworten: 0, manuelleAntworten: 0, chatsMitEingang: 3, davonPausiert: 0 }];
  assert.equal(kanalWirkungVerdict(knapp).ok, false);
  const darunter = [{ ...knapp[0], eingang: WIRKUNG_VORGABEN.mindestEingang - 1 }];
  assert.equal(kanalWirkungVerdict(darunter).ok, true);
});

test("ein arbeitender Kanal mit hoher Last meldet nichts", () => {
  // 12.09.2026, Muenchen Instagram: 68 Eingaenge, 29 KI-Antworten. Laeuft.
  const v = kanalWirkungVerdict([
    { studio: "muenchen", kanal: "instagram", eingang: 68, kiAntworten: 29, manuelleAntworten: 20,
      chatsMitEingang: 30, davonPausiert: 5 },
  ]);
  assert.equal(v.ok, true);
});

test("eine einzige KI-Antwort reicht gegen den Stillstands-Befund", () => {
  // Bewusst so: Der Melder unterscheidet "arbeitet gar nicht" von "arbeitet wenig".
  // Eine gesunkene Quote schwankt mit dem Gespraechsverlauf und taugt nicht als Alarm.
  const v = kanalWirkungVerdict([
    { studio: "muenchen", kanal: "whatsapp", eingang: 20, kiAntworten: 1, manuelleAntworten: 15,
      chatsMitEingang: 5, davonPausiert: 2 },
  ]);
  assert.equal(v.ok, true);
});

// ---- Pausenwelle -------------------------------------------------------------

test("ein leergeraeumter Kanal wird gemeldet, obwohl die KI noch antwortet", () => {
  // Der Fall, den beide bestehenden Melder per Query ausschliessen: Die Chats sind
  // pausiert, also "nicht zustaendig", also unsichtbar. Genau deshalb steht er hier.
  const v = kanalWirkungVerdict([
    { studio: "muenchen", kanal: "whatsapp", eingang: 30, kiAntworten: 2, manuelleAntworten: 25,
      chatsMitEingang: 10, davonPausiert: 9 },
  ]);
  assert.equal(v.ok, false);
  assert.equal(v.befunde[0].art, "pausenwelle");
  assert.equal(v.befunde[0].anteilProzent, 90);
});

test("wenige Chats ergeben kein Pausenurteil", () => {
  // 2 von 2 pausiert ist ein Dienstagvormittag, keine Welle.
  const v = kanalWirkungVerdict([
    { studio: "muenchen", kanal: "whatsapp", eingang: 8, kiAntworten: 3, manuelleAntworten: 4,
      chatsMitEingang: 2, davonPausiert: 2 },
  ]);
  assert.equal(v.ok, true);
});

test("Stillstand und Pausenwelle erzeugen zusammen nur EINEN Befund", () => {
  // Zwei Meldungen fuer dieselbe Ursache lesen sich wie zwei Probleme.
  const v = kanalWirkungVerdict([
    { studio: "muenchen", kanal: "whatsapp", eingang: 17, kiAntworten: 0, manuelleAntworten: 11,
      chatsMitEingang: 9, davonPausiert: 9 },
  ]);
  assert.equal(v.befunde.length, 1);
  assert.equal(v.befunde[0].art, "kanal_stumm");
});

// ---- Mehrere Studios, Mandantentrennung --------------------------------------

test("jeder Kanal jedes Studios wird einzeln beurteilt", () => {
  const v = kanalWirkungVerdict([
    { studio: "muenchen", kanal: "whatsapp", eingang: 17, kiAntworten: 0, manuelleAntworten: 11,
      chatsMitEingang: 9, davonPausiert: 8 },
    { studio: "landshut", kanal: "whatsapp", eingang: 19, kiAntworten: 16, manuelleAntworten: 2,
      chatsMitEingang: 8, davonPausiert: 1 },
    { studio: "landshut", kanal: "instagram", eingang: 12, kiAntworten: 0, manuelleAntworten: 9,
      chatsMitEingang: 5, davonPausiert: 1 },
  ]);
  const gemeldet = v.befunde.map((b) => b.kanal).sort();
  assert.deepEqual(gemeldet, ["landshut/instagram", "muenchen/whatsapp"]);
});

test("leere Eingabe ist kein Alarm und kein Absturz", () => {
  assert.equal(kanalWirkungVerdict([]).ok, true);
  assert.equal(kanalWirkungVerdict(undefined).ok, true);
  assert.equal(kanalWirkungVerdict(null).ok, true);
});

// ---- Query-Form --------------------------------------------------------------

test("jede Zaehlung geht ueber chats!inner(platform), nicht ueber messages.platform", () => {
  // Der teuerste Fehler, den dieser Melder machen koennte: `messages.platform` lesen.
  // Die Spalte bleibt fuer ausgehende KI-Nachrichten auf 'instagram' stehen (von der
  // Stats Engine am 04.08.2026 verifiziert). Der Melder saehe WhatsApp dann dauerhaft
  // bei null KI-Antworten und alarmierte rund um die Uhr, bis ihn jemand abschaltet.
  const q = kanalQueries({ accountId: "181e1e05", platform: "whatsapp", seitIso: "2026-09-17T08:00:00Z" });
  for (const [name, pfad] of Object.entries(q)) {
    if (name === "chats") continue;
    assert.match(pfad, /chats!inner\(platform\)/, `${name} muss ueber den Chat-Join gehen`);
    assert.match(pfad, /chats\.platform=eq\.whatsapp/, `${name} muss auf den Kanal filtern`);
    assert.ok(!/[?&]platform=eq\./.test(pfad), `${name} darf messages.platform nicht benutzen`);
  }
});

test("jede Zaehlung filtert auf genau ein Studio", () => {
  // Ohne diesen Filter laese der Melder der einen Organisation die Zahlen der anderen.
  const q = kanalQueries({ accountId: "181e1e05", platform: "whatsapp", seitIso: "2026-09-17T08:00:00Z" });
  for (const pfad of Object.values(q)) {
    assert.match(pfad, /account_id=eq\.181e1e05/);
  }
});

test("die Chat-Abfrage schliesst pausierte Chats NICHT aus", () => {
  // Das ist der ganze Punkt. Wer hier ein `ai_paused=eq.false` ergaenzt, stellt den
  // blinden Fleck wieder her, den dieser Melder schliessen soll.
  const q = kanalQueries({ accountId: "181e1e05", platform: "whatsapp", seitIso: "2026-09-17T08:00:00Z" });
  assert.ok(!/ai_paused=eq\./.test(q.chats), "pausierte Chats muessen mitgezaehlt werden");
  assert.match(q.chats, /select=id,ai_paused,ai_enabled/);
});

test("das Zeitfenster steckt in jeder Zaehlung", () => {
  const q = kanalQueries({ accountId: "a", platform: "whatsapp", seitIso: "2026-09-17T08:00:00Z" });
  assert.match(q.eingang, /created_at=gte\.2026-09-17T08:00:00Z/);
  assert.match(q.kiAntworten, /created_at=gte\.2026-09-17T08:00:00Z/);
  assert.match(q.chats, /last_inbound_at=gte\.2026-09-17T08:00:00Z/);
});

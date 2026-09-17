// Kanal-Wirkungsmelder — misst, ob ein Kanal ARBEITET, nicht ob er LEBT.
//
// WARUM ES DAS GIBT (Vorfall 17.09.2026):
// Andy meldete, dass auf WhatsApp Muenchen "gar nichts geht". Der Watchdog hatte in
// den 30 Stunden davor 272-mal geprueft und 272-mal "OK" gemeldet. Kein Alarm, keine
// Mail. Der Ausfall war real: zwischen 10 und 14 Uhr kamen 17 Kundennachrichten an,
// die KI beantwortete davon KEINE, das Team fing 11 davon von Hand ab.
//
// Der Watchdog war nicht kaputt. Er hat die falschen Dinge gemessen:
//
//   1. Der Ingestion-Check fragte "kam IRGENDWO die letzte Nachricht an?" — ohne
//      Kanal- und ohne Studiofilter. Eine einzige Instagram-Nachricht aus Landshut
//      haelt ihn gruen, auch wenn WhatsApp Muenchen wochenlang tot ist.
//   2. Der Reply-Gap-Check filtert `ai_paused=eq.false`. Ein Chat, den das
//      Takeover-Gate pausiert hat, verschwindet damit aus der Ueberwachung. Ein
//      Kanal, in dem ALLE Chats pausiert sind, ist fuer ihn maximal gesund.
//   3. Der interne n8n-Melder macht dasselbe (`health-check.live.js`:
//      `if(...||f.ai_paused===true) continue;`).
//
// Der haeufigste Ausfallmodus dieser Anlage war also exakt der blinde Fleck beider
// Melder. Kein Melder hat je verglichen, wie viel reinkam gegen wie viel beantwortet
// wurde — die eine Zahl, an der man den Ausfall sofort sieht.
//
// Dieser Melder stellt genau diese Frage, und zwar je Studio UND Kanal getrennt.
//
// FLUGHOEHE: Es gilt dieselbe Regel wie fuer alle Melder dieser Anlage (Promise,
// 25.08.2026: "ich will keine Meldungen mehr von Nicht-Ausfaellen"). Deshalb:
//   - Unter `mindestEingang` Nachrichten im Fenster wird NICHT geurteilt. Ein
//     ruhiger Kanal ist kein kaputter Kanal, und ein Melder, der sonntags schreit,
//     wird weggeklickt.
//   - Gemeldet wird der VOLLSTAENDIGE Stillstand (kein einziger KI-Lauf trotz
//     ausreichend Eingang), nicht eine gesunkene Quote. Eine Quote schwankt mit dem
//     Gespraechsverlauf; eine Null bei 17 Eingaengen tut das nicht.
//   - Die Persistenzregel (zweimal hintereinander, siehe decideAlert in check.js)
//     gilt zusaetzlich und wird hier NICHT dupliziert.

/** Grenzen, innerhalb derer die Schwellen liegen duerfen. Spiegelbild zu config/schema.mjs. */
export const WIRKUNG_VORGABEN = {
  fensterMin: 180,        // gleitendes Fenster, 3 Stunden
  mindestEingang: 5,      // darunter wird nicht geurteilt
  pausenAnteilProzent: 70, // ab hier gilt der Kanal als leergeraeumt
  mindestChatsFuerPausenurteil: 4,
};

/**
 * Entscheidet je Kanal, ob ein Ausfall vorliegt. Reine Funktion, keine IO.
 *
 * @param {Array} kanaele  [{ studio, kanal, eingang, kiAntworten, manuelleAntworten,
 *                            chatsMitEingang, davonPausiert }]
 * @param {Object} opts    ueberschreibt WIRKUNG_VORGABEN
 * @returns {{ ok, befunde[], geprueft[], ungeprueft[] }}
 */
export function kanalWirkungVerdict(kanaele = [], opts = {}) {
  const o = { ...WIRKUNG_VORGABEN, ...opts };
  const befunde = [];
  const geprueft = [];
  const ungeprueft = [];

  for (const k of Array.isArray(kanaele) ? kanaele : []) {
    const name = `${k.studio}/${k.kanal}`;
    const eingang = Number(k.eingang) || 0;
    const ki = Number(k.kiAntworten) || 0;
    const manuell = Number(k.manuelleAntworten) || 0;
    const chats = Number(k.chatsMitEingang) || 0;
    const pausiert = Number(k.davonPausiert) || 0;

    // Zu wenig Verkehr fuer ein Urteil. Das ist KEIN "ok" — es ist "ungeprueft",
    // und es steht im Bericht. Ein Melder, der Stille als Gesundheit ausgibt, ist
    // genau der Melder, der diesen Vorfall verschlafen hat.
    if (eingang < o.mindestEingang) {
      ungeprueft.push({
        kanal: name, eingang, kiAntworten: ki,
        grund: `nur ${eingang} Eingaenge im Fenster (Urteil ab ${o.mindestEingang})`,
      });
      continue;
    }

    geprueft.push({ kanal: name, eingang, kiAntworten: ki, manuelleAntworten: manuell,
                    chatsMitEingang: chats, davonPausiert: pausiert });

    // 1) Vollstaendiger Stillstand. Der Kanal nimmt an und antwortet nicht.
    if (ki === 0) {
      befunde.push({
        kanal: name,
        art: 'kanal_stumm',
        text: `${name}: ${eingang} Kundennachrichten in den letzten ${o.fensterMin} Min, ` +
              `davon ${ki} von der KI beantwortet` +
              (manuell > 0 ? ` — das Team hat ${manuell} von Hand aufgefangen` : '') +
              '. Der Kanal nimmt an, antwortet aber nicht.',
        eingang, kiAntworten: ki, manuelleAntworten: manuell,
      });
      continue; // Stillstand schlaegt Pausenwelle; zwei Befunde fuer dieselbe Ursache
    }

    // 2) Pausenwelle. Die KI laeuft noch, aber das Takeover-Gate hat den Kanal
    //    weitgehend leergeraeumt. Ohne diesen Befund bliebe es unsichtbar, weil
    //    pausierte Chats aus JEDER anderen Pruefung herausgefiltert werden.
    if (chats >= o.mindestChatsFuerPausenurteil) {
      const anteil = Math.round((pausiert / chats) * 100);
      if (anteil >= o.pausenAnteilProzent) {
        befunde.push({
          kanal: name,
          art: 'pausenwelle',
          text: `${name}: ${pausiert} von ${chats} aktiven Chats sind auf "KI pausiert" ` +
                `(${anteil} %, Schwelle ${o.pausenAnteilProzent} %). Die KI ist hier faktisch ` +
                'abgeschaltet, ohne dass jemand sie abgeschaltet hat — und pausierte Chats ' +
                'fallen aus allen anderen Pruefungen heraus.',
          chatsMitEingang: chats, davonPausiert: pausiert, anteilProzent: anteil,
        });
      }
    }
  }

  return { ok: befunde.length === 0, befunde, geprueft, ungeprueft };
}

/**
 * Baut die PostgREST-Pfade fuer einen Kanal. Ausgelagert, damit die Query-Form
 * testbar ist, ohne die Datenbank zu befragen.
 *
 * WICHTIG (verifiziert von der TF Stats Engine am 04.08.2026): `messages.platform`
 * ist fuer AUSGEHENDE KI-Nachrichten unzuverlaessig — der Reply-Runner setzt die
 * Spalte nicht, sie bleibt auf 'instagram'. Autoritativ ist der Kanal des CHATS.
 * Deshalb geht JEDE Zaehlung ueber `chats!inner(platform)`. Wer das aendert, zaehlt
 * WhatsApp-Antworten als Instagram und macht den Melder blind.
 */
export function kanalQueries({ accountId, platform, seitIso }) {
  const basis = `account_id=eq.${accountId}&created_at=gte.${seitIso}`;
  const join = `&chats!inner(platform)&chats.platform=eq.${platform}`;
  return {
    eingang: `messages?${basis}&direction=eq.in&source=eq.customer&select=id${join}&limit=1`,
    kiAntworten: `messages?${basis}&direction=eq.out&source=eq.ai&select=id${join}&limit=1`,
    manuelleAntworten: `messages?${basis}&direction=eq.out&source=in.(ig_app,dashboard)&select=id${join}&limit=1`,
    // Chats mit frischem Eingang — Grundgesamtheit fuer den Pausenanteil.
    chats: `chats?account_id=eq.${accountId}&platform=eq.${platform}` +
           `&last_inbound_at=gte.${seitIso}&select=id,ai_paused,ai_enabled`,
  };
}

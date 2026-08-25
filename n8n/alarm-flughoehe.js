// Flughöhe der internen TF-Melder: was ist ein AUSFALL, was nur ein Einzelfall?
//
// Vorgeschichte: der interne Health-Monitor (n8n `jmKYSADWCfHFQyqr`) mailte+telegramte
// ab EINEM Chat, der 7 Min auf eine KI-Antwort wartete. Am 25.08.2026 kam so eine
// Meldung für genau einen Münchner Chat, während die ganze Pipeline nachweislich lief
// (n8n 200, Ingestion 0 h alt, Zernio aktiv, Poll fehlerfrei, andere Chats beantwortet).
// Promise: "ich will keine Meldungen mehr von Nicht-Ausfällen".
//
// Dieselbe Korrektur hat der EXTERNE Watchdog am 11.08.2026 schon bekommen
// (replyGapVerdict: Stau oder Liegenbleiber statt Einzelfall). Diese Datei zieht den
// internen Melder auf dieselbe Flughöhe — und wird hier getestet, statt nur im
// n8n-Node zu leben, wo sie niemand prüfen kann.
//
// Leitsatz: Gemeldet wird, wenn Kunden ohne Antwort bleiben UND es nicht von allein
// weggeht. Einzelfälle, selbstgeheilte Fehler und Zustandsinfos gehören ins Dashboard.

export const DEFAULTS = {
  // Unbeantwortete DMs: ein wartender Chat ist Alltag (Übernahme durchs Studio,
  // Message-Request eines Nicht-Followers, Kunde schreibt in Bursts). Mehrere
  // gleichzeitig sind ein Stau, einer über einer Stunde ist ein Liegenbleiber.
  dmStuckCount: 3,
  dmHardMin: 60,
  // Verarbeitungsfehler: ein einzelner Fehler, der sich nicht selbst geheilt hat,
  // ist ärgerlich, aber kein Ausfall. Eine Häufung ist einer.
  errorCount: 3,
  // Persistenz: ein Problem muss zwei Läufe hintereinander zu sehen sein. Bei
  // 3-Min-Takt heißt das: was binnen 3 Min von allein weggeht, meldet niemand.
  requireConsecutive: true,
  // Anti-Spam wie bisher: dasselbe Problem höchstens alle 30 Min.
  cooldownMs: 30 * 60 * 1000,
};

// Ist dieses Problem ein Ausfall? (reine Schwellenfrage, ohne Zeitgedächtnis)
export function istAusfall(problem, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!problem || typeof problem !== 'object') return false;
  if (problem.kind === 'Unbeantwortete DMs') {
    const n = Number(problem.stuckCount) || 0;
    const oldest = Number(problem.oldestStuckMin) || 0;
    return n >= o.dmStuckCount || oldest >= o.dmHardMin;
  }
  if (problem.kind === 'Verarbeitungsfehler') {
    return (Number(problem.errorCount) || 0) >= o.errorCount;
  }
  // Unbekannte Problemklassen bleiben meldepflichtig: eine neue Klasse still zu
  // schlucken wäre genau das Blindloch, das der Watchdog verhindern soll.
  return true;
}

// Entscheidet, was JETZT rausgeht. Rein: gleiche Eingabe -> gleiche Ausgabe.
// state = { lastAlert: {key: ts}, pending: {key: ts} }  (n8n staticData)
export function planAlerts({ problems = [], now = 0, state = {}, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const lastAlert = { ...(state.lastAlert || {}) };
  const prevPending = { ...(state.pending || {}) };
  const pending = {};
  const send = [];
  const suppressed = [];

  for (const p of problems) {
    const key = `${p.slug}|${p.kind}`;
    if (!istAusfall(p, o)) {
      suppressed.push({ ...p, grund: 'kein Ausfall (unter Schwelle)' });
      continue;
    }
    // Ab hier: Ausfall-würdig. Zweimal hintereinander gesehen?
    // ?? statt ||: ein Zeitstempel 0 ist falsy, aber ein gueltiger "schon gesehen".
    pending[key] = prevPending[key] ?? now;
    if (o.requireConsecutive && prevPending[key] === undefined) {
      suppressed.push({ ...p, grund: 'erst einmal gesehen (wartet auf Bestaetigung)' });
      continue;
    }
    const last = lastAlert[key];
    if (last !== undefined && now - last <= o.cooldownMs) {
      suppressed.push({ ...p, grund: 'Cooldown laeuft' });
      continue;
    }
    lastAlert[key] = now;
    send.push(p);
  }

  return { send, suppressed, state: { ...state, lastAlert, pending } };
}

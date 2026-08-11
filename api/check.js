// TF Watchdog — externer Monitor (läuft auf Vercel, NICHT auf dem n8n-Server).
// Prüft mehrschichtig, ob die Tattoo-Fashion-KI-Automation wirklich arbeitet:
//   1) Ist n8n überhaupt erreichbar?
//   2) Erroren die kritischen Workflows? (n8n Executions API)  ← NEU, Hauptschutz
//   3) Kommen DMs rein, aber es geht KEINE Antwort raus? (Supabase, optional)  ← NEU
// Alarmiert per Resend-Email + optional Telegram.
//
// WARUM NEU (Incident 2026-07-08): Die alte Version prüfte nur n8n-Erreichbarkeit.
// n8n war erreichbar (200), aber der Poll-Workflow "KI-Trigger-Poll" crashte
// wiederholt am Supabase-RPC `ki_pick_due_chats` ("connection aborted") — also
// EINE Ebene unter n8n. Der Watchdog war dafür blind. Die internen Monitore
// (Health-Monitor, Self-Heal-Watchdog) liefen auf demselben Server und erorten
// mit → auch still. Dieser externe Check liest jetzt die n8n-Executions-API und
// schlägt an, sobald die Pipeline-Workflows sichtbar erroren.
//
// Env-Vars (Vercel):
//   N8N_URL                 z.B. https://n8n.dimi-it.com          (Default gesetzt)
//   N8N_API_KEY             n8n Public-API-Key (Settings → API)   ← nötig für Check 2
//   CRON_SECRET             schützt den Endpoint (Vercel-Cron sendet Bearer)
//   RESEND_API_KEY          für Email-Alarm
//   ALERT_EMAIL             Empfänger (z.B. info@vantixai.de)
//   ALERT_FROM              Absender (z.B. "TF Watchdog <buchung@callsam.io>")
//   TELEGRAM_BOT_TOKEN      optional
//   TELEGRAM_CHAT_ID        optional
//   ERROR_WINDOW_MIN        optional, Default 30 (Fehler-Fenster)
//   ERROR_THRESHOLD         optional, Default 4  (ab so vielen Fehlern/Workflow = Alarm)
//   SUPABASE_URL            optional (Reply-Gap-Check)
//   SUPABASE_SERVICE_KEY    optional (Service-Role, für RLS-freien Read)
//   REPLY_GAP_MIN           optional, Default 25 (Min. ohne Antwort trotz Eingang)
//   REPLY_STUCK_COUNT       optional, Default 2  (ab so vielen hängenden Chats = Stau)
//   REPLY_GAP_HARD_MIN      optional, Default 60 (ein Chat so lange = liegen geblieben)
//   INGEST_HARD_STALE_H     optional, Default 36 (Reißleine; schnell meldet Zernio)
//   ZERNIO_API_KEY          Zernio-Webhook-Status (der eigentliche Ingestion-Melder)
//   ZERNIO_WEBHOOK_MATCH    optional, Default "tattoo-fashion-zernio-ingest"
//
// Kritische Workflows (n8n-IDs → Klartext). Erroren die, ist die KI beeinträchtigt.
const CRITICAL_WORKFLOWS = {
  C4VjxQI2NGcYKKn5: "KI-Trigger-Poll (holt fällige Chats)",
  pTXykbS5npfLp7nF: "KI-Reply-Runner (erzeugt+sendet Antwort)",
  jmKYSADWCfHFQyqr: "KI-Health-Monitor (intern)",
  aN9yDA7rqNUWeTDX: "KI-Self-Heal-Watchdog (intern)",
};

async function withTimeout(fn, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
}

async function checkN8n(url) {
  try {
    const res = await withTimeout((signal) => fetch(url, { signal, redirect: "manual" }), 10000);
    // 200-499 = Server lebt (auch 401/404 heißt: er antwortet). Nur echte Nichterreichbarkeit = down.
    return { ok: res.status > 0 && res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e).slice(0, 120) };
  }
}

// KI-Antwortfenster — WOHER es kommt, ist der Punkt (Fix 2026-08-11):
// Vorher stand hier "Mo-Fr 18-10 + Sa/So" FEST IM CODE, mit der Begründung
// "tagsüber antwortet eh das Studio manuell". Damit war der Watchdog Mo-Fr
// zwischen 10 und 18 Uhr blind: hängende Chats wurden schlicht nicht gemeldet.
// In Wahrheit steht das Fenster pro Studio in der DB (ki_active_hours_start/
// _end/_weekend, im Dashboard einstellbar) — der n8n-Reply-Runner liest genau
// diese Spalten. Der Monitor liest sie jetzt auch, statt sie zu raten: stellt
// das Studio auf 24/7, überwacht der Watchdog automatisch 24/7 mit.
const BERLIN_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":");
  return Number(h) * 60 + Number(m || 0);
};

export function kiWindowActive(account = {}, nowMs = Date.now()) {
  const start = account.ki_active_hours_start;
  const end = account.ki_active_hours_end;
  // Nicht konfiguriert oder Start==Ende → rund um die Uhr. Bewusst so: eine leere
  // Spalte darf kein stilles Blindloch erzeugen, sie muss zu MEHR Beobachtung führen.
  if (!start || !end || start === end) return true;

  const parts = Object.fromEntries(
    BERLIN_CLOCK.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value])
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") {
    // Wochenend-Semantik exakt wie im n8n-Reply-Runner: nur true heißt aktiv.
    return account.ki_active_weekend === true;
  }
  const s = toMinutes(start);
  const e = toMinutes(end);
  // Ein Fenster, das praktisch den ganzen Tag abdeckt, IST 24/7. TF steht real auf
  // "00:00:00-23:59:59" — naiv gerechnet wäre 23:59 Uhr eine blinde Minute pro Tag.
  if (e - s >= 1439) return true;
  const now = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return s <= e ? now >= s && now < e : now >= s || now < e;
}

// NEU: Fragt die n8n-Executions-API und zählt Fehler der kritischen Workflows im
// Zeitfenster. Genau DAS hätte den Vorfall 2026-07-08 gemeldet.
async function checkExecutionErrors(n8nUrl) {
  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) return { skipped: true, reason: "N8N_API_KEY nicht gesetzt" };
  const windowMin = Number(process.env.ERROR_WINDOW_MIN || 30);
  const threshold = Number(process.env.ERROR_THRESHOLD || 4);
  const since = Date.now() - windowMin * 60 * 1000;
  try {
    const res = await withTimeout(
      (signal) => fetch(
        `${n8nUrl.replace(/\/$/, "")}/api/v1/executions?status=error&limit=100&includeData=false`,
        { signal, headers: { "X-N8N-API-KEY": apiKey, accept: "application/json" } }
      ), 12000);
    if (!res.ok) return { skipped: false, ok: true, note: `Executions-API HTTP ${res.status}` };
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    const counts = {};
    for (const e of rows) {
      const started = e.startedAt ? new Date(e.startedAt).getTime() : 0;
      if (started < since) continue;
      const wf = e.workflowId;
      if (CRITICAL_WORKFLOWS[wf]) counts[wf] = (counts[wf] || 0) + 1;
    }
    const offenders = Object.entries(counts)
      .filter(([, n]) => n >= threshold)
      .map(([wf, n]) => ({ workflowId: wf, name: CRITICAL_WORKFLOWS[wf], errors: n }));
    return {
      skipped: false,
      ok: offenders.length === 0,
      windowMin,
      threshold,
      counts: Object.fromEntries(Object.entries(counts).map(([wf, n]) => [CRITICAL_WORKFLOWS[wf], n])),
      offenders,
    };
  } catch (e) {
    // API-Fehler soll NICHT als "gesund" durchgehen und auch nicht dauer-alarmieren.
    return { skipped: false, ok: true, note: "Executions-Check fehlgeschlagen: " + String(e).slice(0, 100) };
  }
}

// LETZTE REISSLEINE (Rückbau 11.08.2026). Ursprünglich war dies der Hauptschutz
// gegen den stillen 13-Tage-Ausfall vom Juni: Zernio lieferte keine Webhooks mehr,
// es gab weder Fehler noch Executions — nur Stille. Der Check erschloss das aus dem
// Alter der jüngsten eingehenden Nachricht.
//
// Ein Rückschluss aus Stille braucht aber Annahmen darüber, wann Kunden schreiben
// (erst 12h Wanduhr → Fehlalarme nach ruhigen Nächten, dann Aktivstunden 09-23 →
// eine Annahme, die mangels DB-Zugang nie überprüft werden konnte). Seit checkZernio()
// den Webhook-Status DIREKT abfragt, ist dieser Umweg überflüssig: Zernio meldet
// denselben Ausfall in 5 Minuten statt in Stunden, deterministisch und ohne Uhr.
//
// Geblieben ist eine grobe Reißleine für den Restfall "Zernio meldet sich gesund,
// es kommt trotzdem nichts an". 36h liegt weit über der längsten je beobachteten
// natürlichen Lücke (16,3h) und halbiert die blinde Zeit, falls der Zernio-Check
// mal ausfällt (er hängt an einem geborgten API-Key).
export function ingestionVerdict(lastMs, nowMs, opts = {}) {
  const staleH = Number(opts.staleH ?? process.env.INGEST_HARD_STALE_H ?? 36);
  const ageHours = Math.round(((nowMs - lastMs) / 3.6e6) * 10) / 10;
  const dead = ageHours > staleH;
  return {
    ageHours,
    staleThresholdH: staleH,
    dead,
    reason: dead ? `${ageHours}h ohne eingehende DM (Schwelle ${staleH}h)` : null,
  };
}

async function checkIngestion() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { skipped: true, reason: "SUPABASE_SERVICE_KEY nicht gesetzt" };
  const base = url.replace(/\/$/, "");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  try {
    const res = await withTimeout(
      (signal) => fetch(
        `${base}/rest/v1/messages?select=created_at&direction=eq.in&order=created_at.desc&limit=1`,
        { signal, headers }
      ), 10000);
    if (!res.ok) return { skipped: false, ok: true, note: `Ingestion-Check HTTP ${res.status}` };
    const rows = await res.json();
    const last = rows?.[0]?.created_at ? new Date(rows[0].created_at) : null;
    if (!last) return { skipped: false, ok: false, reason: "keine eingehenden Nachrichten in DB" };
    const verdict = ingestionVerdict(last.getTime(), Date.now());
    return {
      skipped: false,
      ok: !verdict.dead,
      lastInbound: last.toISOString(),
      ...verdict,
    };
  } catch (e) {
    return { skipped: false, ok: true, note: "Ingestion-Check fehlgeschlagen: " + String(e).slice(0, 100) };
  }
}

// ---- Zernio-Webhook: die QUELLE fragen statt aus Stille zu schließen ---------
// Der Ingestion-Check oben ist ein Rückschluss ("seit X Stunden nichts gehört,
// also wohl tot") und braucht deshalb Annahmen über Uhrzeiten. Zernio beantwortet
// dieselbe Frage direkt: Der 13-Tage-Ausfall im Juni war ein AUTO-DEAKTIVIERTER
// Webhook (isActive:false, disabledReason:auto:consecutive_failures) — das stand
// die ganze Zeit in der API, es hat nur niemand gefragt.
// Zusätzlich zählt Zernio Fehlzustellungen, BEVOR es abschaltet: der fremde
// SAM-Webhook lief acht Tage auf Fehlern, ehe er deaktiviert wurde. Genau diese
// Vorwarnzeit nutzt der Check.
export function zernioVerdict(payload, opts = {}) {
  const match = opts.match || process.env.ZERNIO_WEBHOOK_MATCH || "tattoo-fashion-zernio-ingest";
  const failureThreshold = Number(opts.failureThreshold ?? process.env.ZERNIO_FAILURE_THRESHOLD ?? 3);
  const list = payload?.webhooks;
  if (!Array.isArray(list)) {
    // Antwortform überrascht → NICHT alarmieren. Ein Monitor, der bei jeder
    // API-Änderung schreit, wird weggeklickt.
    return { ok: true, note: "Zernio-Antwort unerwartet (keine webhooks-Liste)" };
  }

  const wh = list.find((w) => String(w?.url || "").includes(match));
  if (!wh) {
    return {
      ok: false,
      found: false,
      problems: [`Zernio-Webhook für "${match}" ist nicht registriert — Zernio liefert keine DMs mehr an n8n.`],
      // Fremde Webhooks nur namentlich, zur Orientierung. Niemals Secrets.
      others: list.map((w) => ({ name: w?.name, isActive: w?.isActive === true })),
    };
  }

  const problems = [];
  if (wh.isActive !== true) {
    problems.push(
      `Zernio hat den Webhook DEAKTIVIERT (${wh.disabledReason || "Grund unbekannt"}${wh.disabledAt ? `, seit ${wh.disabledAt}` : ""}) — Instagram-DMs erreichen n8n nicht mehr.`
    );
  } else if (Number(wh.failureCount) >= failureThreshold) {
    problems.push(
      `Zernio-Zustellungen scheitern (${wh.failureCount} Fehler, ab ${failureThreshold} gemeldet) — noch aktiv, aber Zernio schaltet den Webhook irgendwann selbst ab.`
    );
  }

  return {
    ok: problems.length === 0,
    found: true,
    isActive: wh.isActive === true,
    failureCount: Number(wh.failureCount) || 0,
    lastFiredAt: wh.lastFiredAt || null,
    disabledReason: wh.disabledReason || null,
    problems,
    others: list
      .filter((w) => w !== wh)
      .map((w) => ({ name: w?.name, isActive: w?.isActive === true })),
  };
}

async function checkZernio() {
  const key = process.env.ZERNIO_API_KEY;
  if (!key) return { skipped: true, reason: "ZERNIO_API_KEY nicht gesetzt" };
  const base = process.env.ZERNIO_API_URL || "https://zernio.com/api/v1";
  try {
    const res = await withTimeout(
      (signal) => fetch(`${base}/webhooks/settings`, {
        signal,
        headers: { Authorization: `Bearer ${key}` },
      }), 10000);
    if (!res.ok) return { skipped: false, ok: true, note: `Zernio-Check HTTP ${res.status}` };
    return { skipped: false, ...zernioVerdict(await res.json()) };
  } catch (e) {
    return { skipped: false, ok: true, note: "Zernio-Check fehlgeschlagen: " + String(e).slice(0, 100) };
  }
}

// Der zweite Blind-Spot — DMs kommen rein, aber KEINE Antwort geht raus.
// Bleibt inaktiv, bis SUPABASE_SERVICE_KEY gesetzt ist.
//
// WICHTIG (Fix 2026-07-20): früher verglich dieser Check nur GLOBAL "jüngster
// Eingang" vs. "jüngste Antwort". Das erzeugte Dauer-Fehlalarme, sobald ein Chat
// im Mensch-Takeover ist (ai_paused=true, "Direkt in Instagram beantwortet"):
// die KI SOLL dort schweigen, der Kunde schreibt aber nach → global sah es aus
// wie "KI antwortet nicht". Promises Postfach lief damit voll.
// Neu: pro Chat, und NUR Chats zählen, in denen die KI tatsächlich zuständig ist:
//   - ai_enabled=true UND ai_paused=false   (kein Takeover, keine Pause)
//   - Account ki_global_on=true             (KI global an)
//   - letzter Eingang älter als gapMin      (KI hätte längst antworten müssen)
//   - danach kam WEDER Antwort NOCH KI-Lauf (last_outbound_at/last_ai_run_at < Eingang)
// So bleiben übernommene/pausierte Chats außen vor; gemeldet wird nur, wenn die
// KI wirklich zuständig ist und trotzdem hängt.
// FLUGHÖHE (Fix 11.08.2026): Nachdem das Werktags-Blindloch zu war, meldete der
// Watchdog sofort einen EINZELNEN Chat, der 25 Min wartete. Das ist die falsche
// Flughöhe für einen externen Monitor — Einzelfälle deckt der interne n8n-Monitor
// ab (ab 7 Min) und das Dashboard. Dazu kommt: Übernimmt das Studio einen Chat von
// Hand, wird das erst erkannt, wenn der Mensch antwortet; bis dahin sieht der Chat
// aus wie "hängt". Gemeldet wird deshalb der STAU (mehrere gleichzeitig) oder der
// echte Liegenbleiber (einer über einer Stunde). Bewusst ohne Uhrzeit-Annahme, sonst
// wäre es derselbe Fehler wie das alte fest einkompilierte Fenster.
export function replyGapVerdict(stuck = [], opts = {}) {
  const minCount = Number(opts.minCount ?? process.env.REPLY_STUCK_COUNT ?? 2);
  const hardMin = Number(opts.hardMin ?? process.env.REPLY_GAP_HARD_MIN ?? 60);
  const oldestStuckMin = stuck.reduce((max, c) => Math.max(max, Number(c?.inboundAgeMin) || 0), 0);
  return {
    stuckCount: stuck.length,
    oldestStuckMin,
    stalledReply: stuck.length >= minCount || oldestStuckMin >= hardMin,
    minCount,
    hardMin,
  };
}

async function checkReplyGap() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { skipped: true, reason: "SUPABASE_SERVICE_KEY nicht gesetzt" };
  const gapMin = Number(process.env.REPLY_GAP_MIN || 25);
  const base = url.replace(/\/$/, "");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const cutoff = new Date(Date.now() - gapMin * 60000).toISOString();
  try {
    // Kandidaten: KI zuständig + Eingang alt genug. Spalten-zu-Spalten-Vergleich
    // (Antwort älter als Eingang) macht PostgREST nicht → in JS nachfiltern.
    const q =
      `${base}/rest/v1/chats?select=id,last_inbound_at,last_outbound_at,last_ai_run_at,` +
      `accounts!inner(slug,ki_global_on,ki_active_hours_start,ki_active_hours_end,ki_active_weekend)` +
      `&ai_enabled=eq.true&ai_paused=eq.false&accounts.ki_global_on=eq.true` +
      `&last_inbound_at=not.is.null&last_inbound_at=lt.${cutoff}` +
      `&order=last_inbound_at.desc&limit=300`;
    const res = await withTimeout((signal) => fetch(q, { signal, headers }), 10000);
    if (!res.ok) return { skipped: false, ok: true, note: `Reply-Gap-Check HTTP ${res.status}` };
    const rows = await res.json();
    const now = Date.now();
    const hanging = (Array.isArray(rows) ? rows : []).filter((c) => {
      const inT = new Date(c.last_inbound_at).getTime();
      const outT = c.last_outbound_at ? new Date(c.last_outbound_at).getTime() : 0;
      const runT = c.last_ai_run_at ? new Date(c.last_ai_run_at).getTime() : 0;
      // Weder Antwort noch KI-Lauf NACH dem Eingang → Chat hängt wirklich.
      return outT < inT && runT < inT;
    });
    // Gemeldet wird nur, was in das Antwortfenster DES JEWEILIGEN Studios fällt —
    // aus der DB gelesen, nicht geraten. Steht das Studio auf 24/7, ist immer Fenster.
    const stuck = hanging
      .filter((c) => kiWindowActive(c.accounts || {}, now))
      .map((c) => ({
        chat: c.id,
        account: c.accounts?.slug || "?",
        inboundAgeMin: Math.round((now - new Date(c.last_inbound_at).getTime()) / 60000),
      }));
    // Was außerhalb des Fensters hängt, ist kein Alarm, aber sichtbar: daran sieht
    // man, ob das konfigurierte Fenster zur Wirklichkeit passt.
    const outsideWindow = hanging.length - stuck.length;
    // Welche Fenster tatsächlich in der DB stehen — pro Studio, zum Nachschauen.
    const windows = {};
    for (const c of Array.isArray(rows) ? rows : []) {
      const a = c.accounts || {};
      if (!a.slug || windows[a.slug]) continue;
      windows[a.slug] = a.ki_active_hours_start && a.ki_active_hours_end
        ? `${a.ki_active_hours_start}-${a.ki_active_hours_end}${a.ki_active_weekend === true ? " +Sa/So" : " ohne Sa/So"}`
        : "24/7 (nicht konfiguriert)";
    }
    const verdict = replyGapVerdict(stuck);
    return {
      skipped: false,
      ok: !verdict.stalledReply,
      gapMin,
      windows,
      stuckChats: stuck.slice(0, 10),
      outsideWindow,
      ...verdict,
    };
  } catch (e) {
    return { skipped: false, ok: true, note: "Reply-Gap-Check fehlgeschlagen: " + String(e).slice(0, 100) };
  }
}

// ---- Alarm-Entprellung (Anti-Spam) -----------------------------------------
// Problem: früher mailte JEDER Check, der ein Problem sah. Ein Reply-Gap, der
// 100 Min anhält, erzeugte bei 5-Min-Takt ~20 identische Mails (Incident
// 2026-07-11: ~10 Mails für EINEN steckengebliebenen DM). Fix: Der Aufrufer
// (GitHub-Action) merkt sich den letzten Zustand und übergibt ihn als ?prev=…
// & ?sinceAlert=…; diese reine Funktion entscheidet dann, ob wirklich gemailt
// wird — nur bei NEUEM Problem, nach Ablauf des Remind-Intervalls, oder bei
// Entwarnung.

// Stabiler Fingerprint NUR aus Zustands-Flags — bewusst OHNE Minutenzahlen,
// damit er sich nicht bei jedem Ping ändert, solange dasselbe Problem anhält.
export function computeFingerprint({ ingestion, n8n, execErrors, replyGap, zernio }, hasProblems) {
  if (!hasProblems) return "OK";
  const offenders = (execErrors?.offenders || []).map((o) => o.workflowId).sort().join(",");
  return [
    `ing:${!!ingestion?.dead || ingestion?.reason === "keine eingehenden Nachrichten in DB"}`,
    `n8n:${!n8n?.ok}`,
    `exec:${offenders}`,
    `reply:${!!replyGap?.stalledReply}`,
    // Nicht `!zernio?.ok` — ein übersprungener Check (kein API-Key) hat gar kein
    // ok-Feld und darf nicht als Problem durchgehen.
    `zern:${zernio?.ok === false}`,
  ].join("|");
}

// Entscheidet, welche Aktion der Handler ausführt: neues/erneuertes Problem
// mailen, Entwarnung mailen, oder still bleiben.
// PERSISTENZ (11.08.2026): Früher mailte der erste Ping, der ein Problem sah. Alles
// Flüchtige landete damit sofort im Postfach und war beim Lesen längst vorbei — ein
// n8n-Aussetzer, ein Wackler beim Deploy, ein Chat, der gerade beantwortet wird.
// Ein Problem muss jetzt ZWEIMAL hintereinander auftauchen (5 Min Abstand), bevor
// gemailt wird. Kostet 5 Minuten Meldeverzug, spart den Großteil der Fehlalarme.
//
// `alertedFp` = der Fingerprint, über den zuletzt WIRKLICH gemailt wurde. Vorher hing
// die Entwarnung an `prev` (zuletzt gesehener Zustand) — dadurch kam eine "wieder OK"-
// Mail auch für Probleme, von denen der Empfänger nie erfahren hatte.
export function decideAlert({ hasProblems, fp, prev, alertedFp, sinceAlert, remind, notifyOff }) {
  if (notifyOff) return "none";               // Hard-Mute (stiller Status-Ping)
  // Ältere Kettenglieder schicken alertedFp noch nicht mit → auf prev zurückfallen,
  // sonst würde beim Rollout jeder Ping erneut mailen.
  const gemeldet = alertedFp === undefined ? prev : alertedFp;
  if (hasProblems) {
    if (fp !== prev) return "none";           // erst bestätigen lassen
    if (fp !== gemeldet) return "problem";    // zweimal gesehen, noch nicht gemeldet
    return sinceAlert >= remind ? "problem" : "none"; // sonst nur die 2h-Erinnerung
  }
  // Keine Probleme: nur mailen, wenn über ein Problem auch wirklich informiert wurde.
  return gemeldet && gemeldet !== "OK" ? "resolved" : "none";
}

// Eine Alarm-Mail ohne nächsten Schritt ist nur Beunruhigung. Pro erkanntem
// Problem genau eine Zeile, was jetzt zu tun ist — in der Reihenfolge, in der man
// es abarbeiten würde (Ursache vor Symptom).
function naechsteSchritte({ zernio, ingestion, n8n, execErrors, replyGap }) {
  const s = [];
  if (zernio?.ok === false) {
    s.push("→ Zernio-Dashboard: Webhook wieder aktivieren. Er ist die Quelle — solange er aus ist, hilft alles andere nichts.");
  }
  if (!n8n?.ok) {
    s.push("→ n8n-Server prüfen (Hetzner bei Dimi). Beim letzten Mal war die Rechnung nicht bezahlt und der Server suspendiert.");
  }
  if (execErrors?.offenders?.length) {
    s.push("→ n8n öffnen, Executions des genannten Workflows ansehen. Meist ist Supabase kurz nicht erreichbar.");
  }
  if (ingestion?.dead) {
    s.push("→ Kette Zernio → n8n → Supabase durchgehen. Wenn Zernio oben gesund meldet, liegt es hinter dem Webhook.");
  }
  if (replyGap?.stalledReply) {
    s.push("→ Genannte Chats im Dashboard öffnen. Antwortet ein Mensch bereits, ist nichts zu tun; sonst KI-Status des Chats prüfen.");
  }
  return s.length ? s : ["→ Details siehe oben."];
}

async function sendEmail(subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !process.env.ALERT_EMAIL) return { skipped: true };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.ALERT_FROM || "TF Watchdog <onboarding@resend.dev>",
      to: [process.env.ALERT_EMAIL],
      subject,
      text,
    }),
  });
  return { ok: res.ok, status: res.status };
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { skipped: true };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  });
  return { ok: res.ok };
}

export default async function handler(req, res) {
  // Auth: Vercel-Cron sendet "Authorization: Bearer <CRON_SECRET>". Manuell: ?key=<CRON_SECRET>.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const manual = req.query?.key && req.query.key === secret;
  if (secret && auth !== `Bearer ${secret}` && !manual) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const n8nUrl = process.env.N8N_URL || "https://n8n.dimi-it.com";
  const [n8n, execErrors, ingestion, replyGap, zernio] = await Promise.all([
    checkN8n(n8nUrl),
    checkExecutionErrors(n8nUrl),
    checkIngestion(),
    checkReplyGap(),
    checkZernio(),
  ]);

  const problems = [];
  // Zernio zuerst: die einzige Auskunft, die kein Rückschluss ist. Sagt Zernio
  // "Webhook aus", ist die Ursache damit benannt, nicht nur das Symptom.
  for (const p of zernio.problems || []) problems.push(`ZERNIO: ${p}`);
  // Dann die Stille — der gefährlichste, weil komplett lautlose Ausfall.
  if (ingestion.dead) {
    problems.push(`INGESTION TOT: seit ${ingestion.ageHours}h keine eingehende DM in der DB (letzte ${ingestion.lastInbound}) — ${ingestion.reason}. Zernio→n8n liefert nicht — Instagram-DMs werden NICHT verarbeitet.`);
  }
  if (ingestion.reason === "keine eingehenden Nachrichten in DB") {
    problems.push("INGESTION: keine eingehenden Nachrichten in der DB gefunden — Pipeline prüfen.");
  }
  if (!n8n.ok) {
    problems.push(`n8n NICHT erreichbar (${n8nUrl}) — Status ${n8n.status}${n8n.error ? " / " + n8n.error : ""}`);
  }
  if (execErrors.offenders?.length) {
    for (const o of execErrors.offenders) {
      problems.push(`Workflow "${o.name}" erort: ${o.errors} Fehler in ${execErrors.windowMin} Min — Pipeline beeinträchtigt`);
    }
  }
  if (replyGap.stalledReply) {
    const detail = (replyGap.stuckChats || [])
      .map((c) => `${c.account}/${String(c.chat).slice(0, 8)} (${c.inboundAgeMin} Min)`)
      .join(", ");
    problems.push(
      `${replyGap.stuckCount} Chat(s) ohne KI-Antwort, ältester seit ${replyGap.oldestStuckMin} Min, obwohl die KI zuständig ist (nicht pausiert/übernommen): ${detail}`
    );
  }
  // Test-Trigger: ?simulate=down erzwingt einen Alarm (Alarm-Weg-Test).
  if (req.query?.simulate === "down") problems.push("TEST-ALARM (simulate=down) — kein echtes Problem, nur Alarm-Weg-Test.");

  // Alarm-Entprellung: Zustand kommt vom Aufrufer (GitHub-Action) via Query.
  const fp = computeFingerprint({ ingestion, n8n, execErrors, replyGap, zernio }, problems.length > 0);
  const prev = typeof req.query?.prev === "string" ? req.query.prev : null;
  const alertedFp = typeof req.query?.alertedFp === "string" ? req.query.alertedFp : undefined;
  const sinceAlert = Number(req.query?.sinceAlert);
  const remind = Number(req.query?.remind || process.env.REMIND_SEC || 7200); // 2h Default
  const notifyOff = req.query?.notify === "0";
  const action = decideAlert({
    hasProblems: problems.length > 0,
    fp,
    prev,
    alertedFp,
    sinceAlert: Number.isFinite(sinceAlert) ? sinceAlert : Infinity,
    remind,
    notifyOff,
  });

  let alerted = null;
  if (action === "problem") {
    const subject = "🚨 Tattoo Fashion Automation: PROBLEM";
    const body = [
      "Der Watchdog hat ein Problem erkannt:",
      "",
      ...problems.map((p) => "• " + p),
      "",
      "Was zu tun ist:",
      ...naechsteSchritte({ zernio, ingestion, n8n, execErrors, replyGap }),
      "",
      `Zeit: ${new Date().toISOString()}`,
      "(Gemeldet wird erst, wenn ein Problem zweimal hintereinander auftaucht — diese",
      "Meldung stand also mindestens 5 Minuten an. Wiederholung frühestens in 2h.)",
    ].join("\n");
    const [email, tg] = await Promise.all([sendEmail(subject, body), sendTelegram(subject + "\n\n" + body)]);
    alerted = { problem: true, email, telegram: tg };
  } else if (action === "resolved") {
    const subject = "✅ Tattoo Fashion Automation: wieder OK";
    const body = [
      "Entwarnung — die Automation läuft wieder normal.",
      "",
      `Letzter Eingang: ${ingestion.lastInbound || "?"}`,
      `Offene KI-Chats: ${replyGap.stuckCount ?? 0}`,
      "",
      `Zeit: ${new Date().toISOString()}`,
    ].join("\n");
    const [email, tg] = await Promise.all([sendEmail(subject, body), sendTelegram(subject + "\n\n" + body)]);
    alerted = { resolved: true, email, telegram: tg };
  } else if (notifyOff) {
    alerted = { suppressed: true };
  }

  return res.status(200).json({
    checkedAt: new Date().toISOString(),
    n8n,
    executionErrors: execErrors,
    ingestion,
    replyGap,
    zernio,
    problems,
    fp,
    healthy: problems.length === 0,
    alerted,
  });
}

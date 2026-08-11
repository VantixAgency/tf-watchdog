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
//   INGEST_ACTIVE_STALE_H   optional, Default 12 (Aktivstunden Stille = Ingestion tot)
//   INGEST_HARD_STALE_H     optional, Default 48 (Wanduhr-Reißleine, fensterunabhängig)
//   INGEST_ACTIVE_FROM/_TO  optional, Default 9/23 (Aktivfenster, Stunden Europe/Berlin)
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

// KI-Aktivfenster (Europe/Berlin): Mo-Fr 18-10 + Sa/So ganztägig. Nur dann ist
// "keine Antwort" verdächtig (tagsüber Mo-Fr antwortet eh das Studio manuell).
function inActiveWindow(now = new Date()) {
  const berlin = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const dow = berlin.getDay(); // 0=So, 6=Sa
  if (dow === 0 || dow === 6) return true;
  const h = berlin.getHours();
  return h >= 18 || h < 10;
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

// NEU (Hauptschutz gegen den Incident 2026-06-25): Ingestion tot? DMs kommen auf
// Instagram an, aber Zernio liefert seit Tagen KEINE Webhooks mehr an n8n → gar keine
// neue Nachricht landet in der DB. Das erzeugt WEDER Fehler NOCH Executions — nur
// Stille. Dieser Check misst das Alter der jüngsten eingehenden Nachricht system-
// weit; ist es > INGEST_STALE_HOURS, ist die Ingestion mit hoher Sicherheit tot.
// (Genau das lief 2026-06-25 bis 2026-07-08 unbemerkt: 13 Tage, 312h.)
//
// FEHLALARM-FIX 2026-08-11: Gemessen wurde ursprünglich reine WANDUHR-Zeit. Die
// läuft aber nachts weiter, wo naturgemäß niemand schreibt — der Check konnte
// "gerade schreibt keiner" nicht von "Pipeline tot" unterscheiden und meldete nach
// ruhigen Nächten Ausfälle (belegt 07.08. 10:46 nach 13,6h Lücke und 08.08. 05:29
// nach 16,3h; beide gingen von selbst weg, sobald die erste DM des Tages kam).
// Das ist gefährlicher als es klingt: Dieser Check ist das Netz gegen den stillen
// 13-Tage-Ausfall vom Juni — ein Melder, dem man nicht mehr glaubt, ist keiner.
// Neu zählen nur Stunden, in denen überhaupt DMs eintrudeln (Fenster 09-23 Berlin),
// plus eine 48h-Wanduhr-Reißleine, falls die Fenster-Annahme mal nicht mehr stimmt.
const BERLIN_HOUR = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  hourCycle: "h23",
});

// Stunden zwischen zwei Zeitpunkten, die ins tägliche Aktivfenster fallen.
// Schrittweise gezählt statt per Datumsarithmetik — so ist die Sommer-/Winterzeit-
// Umstellung automatisch korrekt, weil die Berliner Stunde je Schritt direkt aus
// der Zeitzonen-Datenbank kommt.
export function activeHoursBetween(fromMs, toMs, opts = {}) {
  const { fromHour = 9, toHour = 23, stepMin = 15, capH = 72 } = opts;
  if (!(toMs > fromMs)) return 0;
  const stepMs = stepMin * 60000;
  const start = Math.max(fromMs, toMs - capH * 3.6e6);
  let active = 0;
  for (let t = start; t < toMs; t += stepMs) {
    // Letzter Schritt wird angeschnitten, sonst zählte eine Zwei-Minuten-Lücke
    // als volle Viertelstunde.
    const span = Math.min(stepMs, toMs - t);
    const h = Number(BERLIN_HOUR.format(new Date(t + span / 2))) % 24;
    if (h >= fromHour && h < toHour) active += span / 3.6e6;
  }
  return Math.round(active * 100) / 100;
}

// Bewertet die Stille rein rechnerisch (keine Netz-Zugriffe) — dadurch gegen die
// beiden echten Fehlalarme testbar, siehe test/ingestion.test.js.
export function ingestionVerdict(lastMs, nowMs, opts = {}) {
  const activeThresholdH = Number(opts.activeThresholdH ?? process.env.INGEST_ACTIVE_STALE_H ?? 12);
  const hardThresholdH = Number(opts.hardThresholdH ?? process.env.INGEST_HARD_STALE_H ?? 48);
  const fromHour = Number(opts.fromHour ?? process.env.INGEST_ACTIVE_FROM ?? 9);
  const toHour = Number(opts.toHour ?? process.env.INGEST_ACTIVE_TO ?? 23);

  const ageHours = Math.round(((nowMs - lastMs) / 3.6e6) * 10) / 10;
  const activeHours = activeHoursBetween(lastMs, nowMs, {
    fromHour,
    toHour,
    capH: hardThresholdH + 24,
  });

  // Reißleine zuerst: bei langen Ausfällen ist die Wanduhr-Zahl die ehrlichere
  // Aussage — die Aktivstunden sind dann durch den Scan-Deckel gekappt.
  let reason = null;
  if (ageHours > hardThresholdH) {
    reason = `${ageHours}h Wanduhr ohne DM (Reißleine ${hardThresholdH}h)`;
  } else if (activeHours > activeThresholdH) {
    reason = `${activeHours} Aktivstunden ohne DM (Schwelle ${activeThresholdH}, Fenster ${fromHour}-${toHour} Uhr)`;
  }

  return {
    ageHours,
    activeHours,
    activeWindow: `${fromHour}-${toHour}`,
    activeThresholdH,
    hardThresholdH,
    dead: reason !== null,
    reason,
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
      `${base}/rest/v1/chats?select=id,last_inbound_at,last_outbound_at,last_ai_run_at,accounts!inner(slug,ki_global_on)` +
      `&ai_enabled=eq.true&ai_paused=eq.false&accounts.ki_global_on=eq.true` +
      `&last_inbound_at=not.is.null&last_inbound_at=lt.${cutoff}` +
      `&order=last_inbound_at.desc&limit=300`;
    const res = await withTimeout((signal) => fetch(q, { signal, headers }), 10000);
    if (!res.ok) return { skipped: false, ok: true, note: `Reply-Gap-Check HTTP ${res.status}` };
    const rows = await res.json();
    const now = Date.now();
    const stuck = (Array.isArray(rows) ? rows : [])
      .filter((c) => {
        const inT = new Date(c.last_inbound_at).getTime();
        const outT = c.last_outbound_at ? new Date(c.last_outbound_at).getTime() : 0;
        const runT = c.last_ai_run_at ? new Date(c.last_ai_run_at).getTime() : 0;
        // Weder Antwort noch KI-Lauf NACH dem Eingang → Chat hängt wirklich.
        return outT < inT && runT < inT;
      })
      .map((c) => ({
        chat: c.id,
        account: c.accounts?.slug || "?",
        inboundAgeMin: Math.round((now - new Date(c.last_inbound_at).getTime()) / 60000),
      }));
    // Nur im KI-Aktivfenster als Problem werten (Mo-Fr tagsüber antwortet das Studio manuell).
    const stalledReply = stuck.length > 0 && inActiveWindow();
    return {
      skipped: false,
      ok: !stalledReply,
      gapMin,
      inActiveWindow: inActiveWindow(),
      stuckCount: stuck.length,
      stuckChats: stuck.slice(0, 10),
      stalledReply,
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
export function computeFingerprint({ ingestion, n8n, execErrors, replyGap }, hasProblems) {
  if (!hasProblems) return "OK";
  const offenders = (execErrors?.offenders || []).map((o) => o.workflowId).sort().join(",");
  return [
    `ing:${!!ingestion?.dead || ingestion?.reason === "keine eingehenden Nachrichten in DB"}`,
    `n8n:${!n8n?.ok}`,
    `exec:${offenders}`,
    `reply:${!!replyGap?.stalledReply}`,
  ].join("|");
}

// Entscheidet, welche Aktion der Handler ausführt: neues/erneuertes Problem
// mailen, Entwarnung mailen, oder still bleiben.
export function decideAlert({ hasProblems, fp, prev, sinceAlert, remind, notifyOff }) {
  if (notifyOff) return "none";               // Hard-Mute (stiller Status-Ping)
  if (hasProblems) {
    const isNew = fp !== prev;                // Problemtyp hat sich geändert
    const remindDue = sinceAlert >= remind;   // dasselbe Problem lange offen → Erinnerung
    return isNew || remindDue ? "problem" : "none";
  }
  // Keine Probleme: nur mailen, wenn davor ein echtes Problem lief (Entwarnung).
  return prev && prev !== "OK" ? "resolved" : "none";
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
  const [n8n, execErrors, ingestion, replyGap] = await Promise.all([
    checkN8n(n8nUrl),
    checkExecutionErrors(n8nUrl),
    checkIngestion(),
    checkReplyGap(),
  ]);

  const problems = [];
  // Ingestion zuerst — das ist der gefährlichste, weil komplett stille Ausfall.
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
      `${replyGap.stuckCount} Chat(s) warten > ${replyGap.gapMin} Min auf KI-Antwort, obwohl die KI zuständig ist (nicht pausiert/übernommen): ${detail} — KI empfängt, antwortet aber nicht`
    );
  }
  // Test-Trigger: ?simulate=down erzwingt einen Alarm (Alarm-Weg-Test).
  if (req.query?.simulate === "down") problems.push("TEST-ALARM (simulate=down) — kein echtes Problem, nur Alarm-Weg-Test.");

  // Alarm-Entprellung: Zustand kommt vom Aufrufer (GitHub-Action) via Query.
  const fp = computeFingerprint({ ingestion, n8n, execErrors, replyGap }, problems.length > 0);
  const prev = typeof req.query?.prev === "string" ? req.query.prev : null;
  const sinceAlert = Number(req.query?.sinceAlert);
  const remind = Number(req.query?.remind || process.env.REMIND_SEC || 7200); // 2h Default
  const notifyOff = req.query?.notify === "0";
  const action = decideAlert({
    hasProblems: problems.length > 0,
    fp,
    prev,
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
      `Zeit: ${new Date().toISOString()}`,
      "Checks: Ingestion-Frische + n8n-Erreichbarkeit + Workflow-Fehler (Executions-API) + Reply-Gap.",
      "→ Bei INGESTION TOT: Zernio-Verbindung prüfen (Webhook /zernio-ig kommt nicht an).",
      "→ Sonst: n8n öffnen (Executions), betroffenen Workflow prüfen; oft Supabase-Erreichbarkeit.",
      "",
      "(Diese Meldung wiederholt sich frühestens in 2h, solange dasselbe Problem anhält.)",
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
    problems,
    fp,
    healthy: problems.length === 0,
    alerted,
  });
}

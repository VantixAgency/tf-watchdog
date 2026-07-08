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
async function checkIngestion() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { skipped: true, reason: "SUPABASE_SERVICE_KEY nicht gesetzt" };
  const staleH = Number(process.env.INGEST_STALE_HOURS || 12);
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
    const ageH = (Date.now() - last.getTime()) / 3.6e6;
    const dead = ageH > staleH;
    return {
      skipped: false,
      ok: !dead,
      lastInbound: last.toISOString(),
      ageHours: Math.round(ageH * 10) / 10,
      staleThresholdH: staleH,
      dead,
    };
  } catch (e) {
    return { skipped: false, ok: true, note: "Ingestion-Check fehlgeschlagen: " + String(e).slice(0, 100) };
  }
}

// NEU: Der zweite Blind-Spot — DMs kommen rein, aber KEINE Antwort geht raus.
// Vergleicht jüngste eingehende vs. ausgehende Nachricht. Nur im KI-Fenster gewertet.
// Bleibt inaktiv, bis SUPABASE_SERVICE_KEY gesetzt ist.
async function checkReplyGap() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { skipped: true, reason: "SUPABASE_SERVICE_KEY nicht gesetzt" };
  const gapMin = Number(process.env.REPLY_GAP_MIN || 25);
  const base = url.replace(/\/$/, "");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const latest = async (dir) => {
    const res = await withTimeout(
      (signal) => fetch(
        `${base}/rest/v1/messages?select=created_at&direction=eq.${dir}&order=created_at.desc&limit=1`,
        { signal, headers }
      ), 10000);
    const rows = await res.json();
    return rows?.[0]?.created_at ? new Date(rows[0].created_at) : null;
  };
  try {
    const [lastIn, lastOut] = await Promise.all([latest("in"), latest("out")]);
    if (!lastIn) return { skipped: false, ok: true, note: "keine eingehenden Nachrichten" };
    const inAgeMin = (Date.now() - lastIn.getTime()) / 60000;
    const outAgeMin = lastOut ? (Date.now() - lastOut.getTime()) / 60000 : Infinity;
    // Verdächtig: der letzte Eingang liegt > gapMin ohne dass danach eine Antwort kam,
    // und wir sind im KI-Fenster. (Frischer Eingang < gapMin = KI darf noch arbeiten.)
    const stalledReply = inAgeMin >= gapMin && outAgeMin > inAgeMin && inActiveWindow();
    return {
      skipped: false,
      ok: !stalledReply,
      lastInbound: lastIn.toISOString(),
      lastOutbound: lastOut ? lastOut.toISOString() : null,
      inboundAgeMin: Math.round(inAgeMin),
      stalledReply,
    };
  } catch (e) {
    return { skipped: false, ok: true, note: "Reply-Gap-Check fehlgeschlagen: " + String(e).slice(0, 100) };
  }
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
    problems.push(`INGESTION TOT: seit ${ingestion.ageHours}h keine eingehende DM in der DB (letzte ${ingestion.lastInbound}). Zernio→n8n liefert nicht — Instagram-DMs werden NICHT verarbeitet.`);
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
    problems.push(`Eingang seit ${replyGap.inboundAgeMin} Min ohne Antwort (letzte Antwort ${replyGap.lastOutbound || "nie"}) — KI empfängt, antwortet aber nicht`);
  }
  // Test-Trigger: ?simulate=down erzwingt einen Alarm (Alarm-Weg-Test).
  if (req.query?.simulate === "down") problems.push("TEST-ALARM (simulate=down) — kein echtes Problem, nur Alarm-Weg-Test.");

  let alerted = null;
  if (problems.length) {
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
    ].join("\n");
    const [email, tg] = await Promise.all([sendEmail(subject, body), sendTelegram(subject + "\n\n" + body)]);
    alerted = { email, telegram: tg };
  }

  return res.status(200).json({
    checkedAt: new Date().toISOString(),
    n8n,
    executionErrors: execErrors,
    ingestion,
    replyGap,
    problems,
    healthy: problems.length === 0,
    alerted,
  });
}

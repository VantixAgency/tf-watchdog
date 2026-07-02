// TF Watchdog — externer Monitor (läuft auf Vercel, NICHT auf dem n8n-Server).
// Prüft: (1) ist n8n erreichbar, (2) kommen noch Nachrichten rein (optional).
// Alarmiert per Resend-Email + optional Telegram. Von Vercel-Cron getriggert.
//
// Env-Vars (Vercel):
//   N8N_URL                 z.B. https://n8n.dimi-it.com
//   CRON_SECRET             schützt den Endpoint (Vercel-Cron sendet Bearer)
//   RESEND_API_KEY          für Email-Alarm
//   ALERT_EMAIL             Empfänger (z.B. info@vantixai.de)
//   ALERT_FROM              Absender (z.B. "TF Watchdog <buchung@callsam.io>")
//   TELEGRAM_BOT_TOKEN      optional
//   TELEGRAM_CHAT_ID        optional
//   SUPABASE_URL            optional (Frische-Check)
//   SUPABASE_SERVICE_KEY    optional (Service-Role, für RLS-freien Read)
//   STALE_HOURS             optional, Default 3 (nur Mo-Fr 18-10 + Wochenende gewertet)

async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await promise(ctrl.signal); } finally { clearTimeout(t); }
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
// "keine neue Nachricht" verdächtig (tagsüber Mo-Fr antwortet eh das Studio).
function inActiveWindow(now = new Date()) {
  const berlin = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const dow = berlin.getDay(); // 0=So, 6=Sa
  if (dow === 0 || dow === 6) return true;
  const h = berlin.getHours();
  return h >= 18 || h < 10;
}

async function checkFreshness() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { skipped: true };
  const staleHours = Number(process.env.STALE_HOURS || 3);
  try {
    const res = await withTimeout(
      (signal) => fetch(
        `${url}/rest/v1/messages?select=created_at&direction=eq.in&order=created_at.desc&limit=1`,
        { signal, headers: { apikey: key, Authorization: `Bearer ${key}` } }
      ), 10000);
    const rows = await res.json();
    const last = rows?.[0]?.created_at ? new Date(rows[0].created_at) : null;
    if (!last) return { skipped: false, ok: false, reason: "keine Nachrichten gefunden" };
    const ageH = (Date.now() - last.getTime()) / 3.6e6;
    const stale = ageH > staleHours && inActiveWindow();
    return { skipped: false, ok: !stale, lastInbound: last.toISOString(), ageHours: Math.round(ageH * 10) / 10, stale };
  } catch (e) {
    return { skipped: false, ok: true, note: "freshness check failed: " + String(e).slice(0, 80) };
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
  // Auth: Vercel-Cron sendet "Authorization: Bearer <CRON_SECRET>".
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const manual = req.query?.key && req.query.key === secret;
  if (secret && auth !== `Bearer ${secret}` && !manual) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const n8nUrl = process.env.N8N_URL || "https://n8n.dimi-it.com";
  const n8n = await checkN8n(n8nUrl);
  const fresh = await checkFreshness();

  const problems = [];
  if (!n8n.ok) problems.push(`n8n NICHT erreichbar (${n8nUrl}) — Status ${n8n.status}${n8n.error ? " / " + n8n.error : ""}`);
  if (fresh && fresh.stale) problems.push(`Keine neue Kunden-DM seit ${fresh.ageHours}h (letzte ${fresh.lastInbound}) — Pipeline verdächtig`);
  // Test-Trigger: ?simulate=down erzwingt einen Alarm (zum Verifizieren des Alarm-Wegs).
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
      "Check: n8n-Erreichbarkeit + Nachrichten-Frische.",
      "→ Server prüfen (Hetzner) bzw. n8n-Ingest kontrollieren.",
    ].join("\n");
    const [email, tg] = await Promise.all([sendEmail(subject, body), sendTelegram(subject + "\n\n" + body)]);
    alerted = { email, telegram: tg };
  }

  return res.status(200).json({
    checkedAt: new Date().toISOString(),
    n8n,
    freshness: fresh,
    problems,
    healthy: problems.length === 0,
    alerted,
  });
}

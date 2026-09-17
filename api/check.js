// TF Watchdog — externer Monitor (läuft auf Vercel, NICHT auf dem n8n-Server).
// Prüft mehrschichtig, ob die KI-Automation einer Installation wirklich arbeitet.
// Welche Workflows, Empfänger, Schwellen und Anbieter das sind, steht NICHT hier,
// sondern in config/installationen.json — je Organisation (G4).
//   1) Ist n8n überhaupt erreichbar?
//   2) Erroren die kritischen Workflows? (n8n Executions API)
//   3) Kommen DMs rein, aber es geht KEINE Antwort raus? (Supabase, optional)
//   4) ARBEITET jeder Kanal, oder nimmt er nur an? (je Studio × Kanal)  ← NEU 17.09.2026
// Alarmiert per Resend-Email + optional Telegram.
//
// WARUM 4 DAZUKAM (Vorfall 2026-09-17): WhatsApp München antwortete nicht mehr —
// 17 Kundennachrichten zwischen 10 und 14 Uhr, keine einzige KI-Antwort, das Team
// fing 11 von Hand ab. Der Watchdog meldete in den 30 Stunden davor 272-mal "OK".
// Grund: Jede einzelne Prüfung war kanalblind. Der Ingestion-Check fragte global
// "kam irgendwo etwas an?" (Instagram lief → grün), der Reply-Gap-Check filtert
// pausierte Chats weg (und Übernahme pausiert dauerhaft → grün), der Zernio-Check
// prüft einen Webhook für alle Kanäle (→ grün). Keiner verglich Eingang gegen
// Antwort. Prüfung 4 tut genau das, getrennt je Studio und Kanal.
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
//   N8N_URL                 Fallback, wenn die Organisation keinen n8nUrl nennt
//   N8N_API_KEY             n8n Public-API-Key (Settings → API)   ← nötig für Check 2
//   CRON_SECRET             schützt den Endpoint (Vercel-Cron sendet Bearer)
//   RESEND_API_KEY          für Email-Alarm
//   ALERT_EMAIL             Fallback-Empfänger (Organisation geht vor)
//   ALERT_FROM              Fallback-Absender (Organisation geht vor)
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
//   ZERNIO_WEBHOOK_MATCH    Fallback; regulär aus provider.webhookMatch der Organisation
//
// G4: Keine fest codierten Workflow-IDs, Namen, Empfänger oder Anbieter mehr.
// Die Überwachung wird je Installation konfiguriert — siehe config/installationen.json.
// Ein zweiter Mandant wäre sonst unüberwacht geblieben.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pruefeKonfiguration, mitVorgaben, BRAUCHT_N8N } from "../config/schema.mjs";
import { kanalWirkungVerdict, kanalQueries } from "./kanal-wirkung.mjs";

const HIER = dirname(fileURLToPath(import.meta.url));

/** Lädt und VALIDIERT die Monitoring-Konfiguration. Ungültig = harter Fehler, kein stiller Betrieb. */
export function ladeKonfiguration(pfad = join(HIER, "..", "config", "installationen.json")) {
  const roh = JSON.parse(readFileSync(pfad, "utf8"));
  const pruefung = pruefeKonfiguration(roh);
  if (!pruefung.ok) {
    const e = new Error("Monitoring-Konfiguration ungueltig:\n  " + pruefung.fehler.join("\n  "));
    e.code = "CONFIG_INVALID";
    throw e;
  }
  return { ...roh, organisationen: roh.organisationen.map(mitVorgaben) };
}

/** Workflow-ID → Bezeichnung, NUR für diese Organisation. Cross-Tenant-Zugriff unmöglich. */
export function workflowIndex(org) {
  return Object.fromEntries((org.kritischeWorkflows || []).map((w) => [w.id, w.bezeichnung]));
}

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
async function checkExecutionErrors(n8nUrl, org) {
  const apiKey = process.env[org?.secretRefs?.n8nApiKey || "N8N_API_KEY"];
  if (!apiKey) return { skipped: true, reason: "n8n-API-Key nicht gesetzt" };
  const KRITISCH = workflowIndex(org);
  const windowMin = Number(org?.schwellen?.fehlerFensterMin ?? process.env.ERROR_WINDOW_MIN ?? 30);
  const threshold = Number(org?.schwellen?.fehlerSchwelle ?? process.env.ERROR_THRESHOLD ?? 4);
  const since = Date.now() - windowMin * 60 * 1000;
  try {
    const res = await withTimeout(
      (signal) => fetch(
        `${n8nUrl.replace(/\/$/, "")}/api/v1/executions?status=error&limit=100&includeData=false`,
        { signal, headers: { "X-N8N-API-KEY": apiKey, accept: "application/json" } }
      ), 12000);
    // FIX 17.09.2026: Ein abgelehnter Zugang ist KEINE Gesundheit.
    // Vorher gab jeder Nicht-200-Status `ok: true` zurueck — auch ein 401. Der n8n-
    // API-Key laeuft periodisch ab (zuletzt 05.06.2026); ab da haette dieser Melder
    // still "alles gut" gesagt, ohne je eine Execution gesehen zu haben. Ein Melder,
    // der nicht hineinschauen kann, muss das SAGEN, nicht schweigen.
    if (res.status === 401 || res.status === 403) {
      return { skipped: false, ok: false, blind: true,
               note: `Executions-API lehnt den Zugang ab (HTTP ${res.status}) — n8n-API-Key abgelaufen oder ungueltig. Dieser Melder prueft derzeit NICHTS.` };
    }
    // Andere Fehler (5xx, Rate-Limit) sind fremde Stoerungen: nicht alarmieren, aber
    // auch nicht als geprueft ausgeben.
    if (!res.ok) return { skipped: false, ok: true, ungeprueft: true, note: `Executions-API HTTP ${res.status}` };
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    const counts = {};
    for (const e of rows) {
      const started = e.startedAt ? new Date(e.startedAt).getTime() : 0;
      if (started < since) continue;
      const wf = e.workflowId;
      if (KRITISCH[wf]) counts[wf] = (counts[wf] || 0) + 1;   // fremde Workflows: ignoriert
    }
    const offenders = Object.entries(counts)
      .filter(([, n]) => n >= threshold)
      .map(([wf, n]) => ({ workflowId: wf, name: KRITISCH[wf], errors: n }));
    return {
      skipped: false,
      ok: offenders.length === 0,
      windowMin,
      threshold,
      counts: Object.fromEntries(Object.entries(counts).map(([wf, n]) => [KRITISCH[wf], n])),
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

export async function checkIngestion(org) {
  // G4: Datenbankzugang je Organisation. Ohne das laese der Melder einer Organisation
  // in der Datenbank einer anderen -- Cross-Tenant-Datenzugriff.
  const url = process.env[org?.secretRefs?.datenbankUrl || "SUPABASE_URL"];
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { skipped: true, reason: "SUPABASE_SERVICE_KEY nicht gesetzt" };
  const base = url.replace(/\/$/, "");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const kanaeleListe = org?.kanaele?.length ? org.kanaele : ["instagram", "whatsapp"];
  try {
    // FIX 17.09.2026: je Studio UND Kanal, nicht global.
    // Vorher stand hier EINE Abfrage ohne jeden Filter: "wann kam irgendwo die letzte
    // eingehende Nachricht an?". Eine einzige Instagram-Nachricht aus Landshut hielt
    // den Melder gruen — WhatsApp Muenchen haette wochenlang tot sein koennen, ohne
    // dass diese Zahl sich bewegt. Genau das ist am 17.09. passiert.
    const accRes = await withTimeout(
      (signal) => fetch(`${base}/rest/v1/accounts?select=id,slug`, { signal, headers }), 10000);
    if (!accRes.ok) return { skipped: false, ok: true, ungeprueft: true, note: `Accounts-Abfrage HTTP ${accRes.status}` };
    const accounts = await accRes.json();
    if (!Array.isArray(accounts) || accounts.length === 0)
      return { skipped: false, ok: false, reason: "keine Accounts in DB", tote: [], kanaele: [] };

    const paare = [];
    for (const a of accounts) for (const pl of kanaeleListe) paare.push({ a, pl });

    const kanaele = await Promise.all(paare.map(async ({ a, pl }) => {
      const name = `${a.slug || a.id}/${pl}`;
      const q = `${base}/rest/v1/messages?select=created_at&direction=eq.in&source=eq.customer` +
                `&account_id=eq.${a.id}&chats!inner(platform)&chats.platform=eq.${pl}` +
                `&order=created_at.desc&limit=1`;
      const res = await withTimeout((signal) => fetch(q, { signal, headers }), 10000);
      if (!res.ok) return { kanal: name, ungeprueft: true, note: `HTTP ${res.status}` };
      const rows = await res.json();
      const last = rows?.[0]?.created_at ? new Date(rows[0].created_at) : null;
      // Ein Kanal, der noch nie etwas empfangen hat, ist nicht tot — er ist neu.
      // Ihn als Ausfall zu melden waere ein Dauerfehlalarm bis zur ersten Nachricht.
      if (!last) return { kanal: name, nieEmpfangen: true };
      const v = ingestionVerdict(last.getTime(), Date.now(), { staleH: org?.schwellen?.ingestStaleStunden });
      return { kanal: name, lastInbound: last.toISOString(), ...v };
    }));

    const tote = kanaele.filter((k) => k.dead);
    // `dead`/`ageHours` bleiben als Gesamtbild erhalten, damit bestehende Auswertungen
    // und die Entwarnungsmail weiterlaufen.
    const juengste = kanaele.filter((k) => k.lastInbound)
      .sort((a, b) => Date.parse(b.lastInbound) - Date.parse(a.lastInbound))[0];
    return {
      skipped: false,
      ok: tote.length === 0,
      kanaele,
      tote,
      dead: tote.length > 0,
      lastInbound: juengste?.lastInbound || null,
      ageHours: juengste?.ageHours ?? null,
      staleThresholdH: kanaele.find((k) => k.staleThresholdH)?.staleThresholdH ?? null,
      reason: tote.length ? tote.map((t) => `${t.kanal}: ${t.reason}`).join("; ") : null,
    };
  } catch (e) {
    return { skipped: false, ok: true, ungeprueft: true, note: "Ingestion-Check fehlgeschlagen: " + String(e).slice(0, 100) };
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
  // G4: kein Kunden-Literal im Produktkern. Der Match kommt aus der Organisationskonfiguration
  // (provider.webhookMatch). Fehlt er, wird NICHT geraten -- ein Melder, der auf einen falschen
  // Webhook schaut, meldet Gesundheit, die es nicht gibt.
  const match = opts.match || process.env.ZERNIO_WEBHOOK_MATCH;
  if (!match) return { ok: true, found: false, skipped: true, reason: "kein webhookMatch konfiguriert", problems: [] };
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

async function checkZernio(org) {
  const key = process.env[org?.secretRefs?.providerApiKey || "ZERNIO_API_KEY"];
  if (!key) return { skipped: true, reason: "Provider-API-Key nicht gesetzt" };
  const base = process.env.ZERNIO_API_URL || "https://zernio.com/api/v1";
  try {
    const res = await withTimeout(
      (signal) => fetch(`${base}/webhooks/settings`, {
        signal,
        headers: { Authorization: `Bearer ${key}` },
      }), 10000);
    if (!res.ok) return { skipped: false, ok: true, note: `Zernio-Check HTTP ${res.status}` };
    return { skipped: false, ...zernioVerdict(await res.json(), {
      match: org?.provider?.webhookMatch,
      failureThreshold: org?.schwellen?.providerFehler,
    }) };
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

async function checkReplyGap(org) {
  // G4: Datenbankzugang je Organisation. Ohne das laese der Melder einer Organisation
  // in der Datenbank einer anderen -- Cross-Tenant-Datenzugriff.
  const url = process.env[org?.secretRefs?.datenbankUrl || "SUPABASE_URL"];
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

// ---- Kanal-Wirkung: arbeitet jeder Kanal, oder nimmt er nur an? -------------
// Der Melder, der am 17.09.2026 gefehlt hat. Begruendung, Schwellen und Testfaelle
// stehen in ./kanal-wirkung.mjs — hier steht nur die Datenbeschaffung.
//
// Kosten: 2 Studios x 2 Kanaele x 4 Abfragen + 1 Accounts-Abfrage. Alle Zaehlungen
// laufen als HEAD-artige count-Abfragen (Range 0-0), es werden also keine Zeilen
// uebertragen, und alles parallel.
export async function checkKanalWirkung(org) {
  const url = process.env[org?.secretRefs?.datenbankUrl || "SUPABASE_URL"];
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { skipped: true, reason: "SUPABASE_SERVICE_KEY nicht gesetzt" };

  const base = url.replace(/\/$/, "");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const zaehlKopf = { ...headers, Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" };
  const fensterMin = Number(org?.schwellen?.wirkungFensterMin ?? 180);
  const seitIso = new Date(Date.now() - fensterMin * 60000).toISOString();
  const kanaeleListe = org?.kanaele?.length ? org.kanaele : ["instagram", "whatsapp"];

  const zaehle = async (pfad) => {
    const res = await withTimeout((signal) => fetch(`${base}/rest/v1/${pfad}`, { signal, headers: zaehlKopf }), 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cr = res.headers.get("content-range") || "";
    const n = parseInt(cr.split("/")[1], 10);
    return Number.isFinite(n) ? n : 0;
  };

  try {
    const accRes = await withTimeout(
      (signal) => fetch(`${base}/rest/v1/accounts?select=id,slug`, { signal, headers }), 10000);
    if (!accRes.ok) return { skipped: false, ok: true, ungeprueft: true, note: `Accounts-Abfrage HTTP ${accRes.status}` };
    const accounts = await accRes.json();
    if (!Array.isArray(accounts) || accounts.length === 0)
      return { skipped: false, ok: false, note: "keine Accounts in der Datenbank gefunden" };

    const paare = [];
    for (const a of accounts) for (const pl of kanaeleListe) paare.push({ a, pl });

    const kanaele = await Promise.all(paare.map(async ({ a, pl }) => {
      const q = kanalQueries({ accountId: a.id, platform: pl, seitIso });
      const [eingang, kiAntworten, manuelleAntworten, chatsRes] = await Promise.all([
        zaehle(q.eingang),
        zaehle(q.kiAntworten),
        zaehle(q.manuelleAntworten),
        withTimeout((signal) => fetch(`${base}/rest/v1/${q.chats}`, { signal, headers }), 10000)
          .then((r) => (r.ok ? r.json() : [])),
      ]);
      const chats = Array.isArray(chatsRes) ? chatsRes : [];
      return {
        studio: a.slug || a.id,
        kanal: pl,
        eingang,
        kiAntworten,
        manuelleAntworten,
        chatsMitEingang: chats.length,
        // ai_enabled=false ist eine bewusste Abschaltung durch das Studio und zaehlt
        // wie eine Pause: die KI ist in diesem Chat aus, egal aus welchem Grund.
        davonPausiert: chats.filter((c) => c.ai_paused === true || c.ai_enabled === false).length,
      };
    }));

    const verdict = kanalWirkungVerdict(kanaele, {
      fensterMin,
      mindestEingang: org?.schwellen?.wirkungMindestEingang,
      pausenAnteilProzent: org?.schwellen?.wirkungPausenAnteil,
    });
    return { skipped: false, fensterMin, seit: seitIso, ...verdict };
  } catch (e) {
    // Eine gescheiterte Abfrage darf nicht dauer-alarmieren, aber auch nicht als
    // "geprueft und gesund" durchgehen.
    return { skipped: false, ok: true, ungeprueft: true, note: "Kanal-Wirkung nicht messbar: " + String(e).slice(0, 100) };
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
export function computeFingerprint({ ingestion, n8n, execErrors, replyGap, zernio, v2, kanalWirkung }, hasProblems) {
  if (!hasProblems) return "OK";
  const offenders = (execErrors?.offenders || []).map((o) => o.workflowId).sort().join(",");
  // Kanal + Art, aber ohne Zahlen: der Abdruck darf sich nicht bei jedem Ping aendern,
  // solange derselbe Kanal aus demselben Grund steht — sonst mailt die Entprellung nie.
  const kanaele = (kanalWirkung?.befunde || [])
    .map((b) => `${b.kanal}:${b.art}`).sort().join(",");
  return [
    `ing:${!!ingestion?.dead || ingestion?.reason === "keine eingehenden Nachrichten in DB"}`,
    `n8n:${!n8n?.ok}`,
    `exec:${offenders}`,
    `reply:${!!replyGap?.stalledReply}`,
    // Nicht `!zernio?.ok` — ein übersprungener Check (kein API-Key) hat gar kein
    // ok-Feld und darf nicht als Problem durchgehen.
    `zern:${zernio?.ok === false}`,
    // Gleiche Vorsicht wie bei Zernio: Ein uebersprungener Check hat kein ok-Feld und
    // darf nicht als Problem gelten. Ohne den Fingerabdruck wuerde ein V2-Ausfall
    // ausserdem denselben Abdruck tragen wie ein n8n-Ausfall -- die Entprellung
    // haette dann den zweiten Alarm als Wiederholung des ersten verschluckt.
    `v2:${v2?.ok === false}`,
    // Ohne eigenen Abdruck traege ein stummer Kanal denselben wie ein n8n-Ausfall —
    // die Entprellung haette den zweiten Alarm als Wiederholung des ersten geschluckt.
    `kanal:${kanaele}`,
    // Ein Melder, der wegen eines abgelaufenen Schluessels nichts sieht, ist ein
    // eigener Zustand und keine Wiederholung des Problems, das er nicht sehen kann.
    `blind:${execErrors?.blind === true}`,
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
function naechsteSchritte({ zernio, ingestion, n8n, execErrors, replyGap, kanalWirkung }) {
  const s = [];
  for (const b of kanalWirkung?.befunde || []) {
    if (b.art === 'pausenwelle') {
      s.push(`→ ${b.kanal}: Im Dashboard die betroffenen Chats öffnen und "KI wieder aktivieren" klicken. Der globale KI-Schalter hebt eine Chat-Pause NICHT auf — aus- und wieder einschalten hilft hier nicht.`);
    } else {
      s.push(`→ ${b.kanal}: Zuerst prüfen, ob die Chats auf "KI pausiert" stehen (Übernahme durch das Team pausiert dauerhaft). Dann den Kanal-Eintrag in account_channels prüfen — fehlt er, antwortet der Outbound mit 500 und schreibt kein Event.`);
    }
  }
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

async function sendEmail(subject, text, org) {
  const key = process.env.RESEND_API_KEY;
  const an = org?.alarm?.email ?? (process.env.ALERT_EMAIL ? [process.env.ALERT_EMAIL] : []);
  if (!key || an.length === 0) return { skipped: true };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: org?.alarm?.absender || process.env.ALERT_FROM || "Watchdog <onboarding@resend.dev>",
      to: an,
      subject,
      text,
    }),
  });
  return { ok: res.ok, status: res.status };
}

async function sendTelegram(text, org) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = org?.alarm?.telegramChatIds ?? (process.env.TELEGRAM_CHAT_ID ? [process.env.TELEGRAM_CHAT_ID] : []);
  if (!token || chats.length === 0) return { skipped: true };
  const ergebnisse = [];
  for (const chat of chats) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    ergebnisse.push(res.ok);
  }
  return { ok: ergebnisse.every(Boolean) };
}

/**
 * V2-Bereitschaft. Prueft NICHT nur, ob der Dienst antwortet.
 *
 * Ein Melder, der auf HTTP 200 stehenbleibt, wuerde eine stillschweigend abgeschaltete
 * Absicherung durchgehen lassen: eine Tabelle ohne RLS, eine nicht angewendete
 * Migration, ein auf den lokalen Ersatz zurueckgefallener Auth-Adapter. Genau diese
 * Merkmale liefert `/api/bereit` mit, und genau die werden hier geprueft.
 *
 * Die erwartete Migrationszahl steht NICHT hier. Sie waere eine Zahl, die nur in einer
 * Konfiguration lebt und bei jeder Migration nachgezogen werden muesste -- vergisst man
 * das, meldet der Waechter Alarm ohne Anlass, und man gewoehnt sich das Wegklicken an.
 * Geprueft wird stattdessen, dass ueberhaupt Migrationen angewendet sind und dass die
 * Zahl nicht SINKT; den Rest entscheidet der Dienst selbst ueber `ok`.
 */
export async function checkV2Bereit(org, holen = fetch) {
  const basis = String(org.v2Url || "").replace(/\/$/, "");
  if (!basis) return { skipped: true, reason: "v2Url fehlt" };
  const problems = [];
  let bereit = null;
  let gesund = null;
  try {
    gesund = await withTimeout(async (signal) => {
      const a = await holen(`${basis}/api/gesund`, { signal });
      return { status: a.status, body: await a.json().catch(() => ({})) };
    }, 10000);
    if (gesund.status !== 200 || gesund.body?.ok !== true)
      problems.push(`Lebenszeichen fehlt: /api/gesund antwortet ${gesund.status}`);
  } catch (e) {
    problems.push(`Lebenszeichen fehlt: /api/gesund nicht erreichbar (${String(e.message).slice(0, 80)})`);
  }
  try {
    bereit = await withTimeout(async (signal) => {
      const a = await holen(`${basis}/api/bereit`, { signal });
      return { status: a.status, body: await a.json().catch(() => ({})) };
    }, 10000);
  } catch (e) {
    problems.push(`Bereitschaft nicht abfragbar (${String(e.message).slice(0, 80)})`);
    return { ok: false, problems, bereit: null, gesund };
  }
  const b = bereit.body || {};
  if (bereit.status !== 200 || b.ok !== true)
    problems.push(`Dienst meldet sich als NICHT bereit (Status ${bereit.status})`);
  if (!(Number(b.migrationen) > 0))
    problems.push("keine Migration angewendet — das Schema ist leer oder falsch verbunden");
  if (Number(b.tabellenOhneRls) !== 0)
    problems.push(`${b.tabellenOhneRls} Tabelle(n) OHNE Row Level Security — Mandantentrennung offen`);
  if (b.auth !== "supabase")
    problems.push(`Auth-Kette ist "${b.auth}" statt "supabase" — der Dienst laeuft auf einem Ersatzadapter`);
  if (b.benutzerkontext !== true)
    problems.push("Benutzerkontext nicht verdrahtet — Zugriffe liefen privilegiert an RLS vorbei");

  // ── Betriebszahlen ────────────────────────────────────────────────────────
  //
  // `/api/bereit` sagt, dass der Dienst LEBT. Es sagt nicht, ob er ARBEITET.
  // Genau dieser Unterschied war der 13-Tage-Ausfall: Der Dienst antwortete die
  // ganze Zeit mit 200, waehrend seit knapp zwei Wochen keine Nachricht mehr ankam.
  //
  // Die Zahlen kommen ueber einen eigenen, tokengeschuetzten Endpunkt -- der
  // Watchdog bekommt bewusst KEINEN Datenbankzugang. Ein zweites Repository mit
  // service_role waere fuer eine Handvoll Zaehler ein zu hoher Preis.
  const token = process.env[org?.secretRefs?.betriebToken || "V2_BETRIEB_TOKEN"];
  let betrieb = null;
  if (!token) {
    // Kein Token heisst NICHT "alles gut". Es heisst "ungeprueft", und das gehoert
    // in den Bericht -- sonst sieht ein halb verdrahteter Melder aus wie ein gruener.
    problems.push("Betriebszahlen ungeprueft: kein V2_BETRIEB_TOKEN gesetzt");
  } else {
    try {
      betrieb = await withTimeout(async (signal) => {
        const a = await holen(`${basis}/api/betrieb`, { signal, headers: { "x-betrieb-token": token } });
        return { status: a.status, body: await a.json().catch(() => ({})) };
      }, 10000);
      if (betrieb.status !== 200) {
        problems.push(`Betriebszahlen nicht abrufbar (Status ${betrieb.status})`);
      } else {
        const d = betrieb.body || {};
        const s = org?.schwellen || {};
        const altMin = (wert) => (wert ? Math.round((Date.now() - Date.parse(wert)) / 60000) : null);

        // Stille im Eingang. Die Schwelle ist bewusst grosszuegig und je Installation
        // einstellbar: In Staging kommt tagelang nichts an, und ein Melder, der
        // deshalb dauernd rot ist, wird abgeschaltet.
        const eingangMin = altMin(d.letzterEingang);
        const eingangGrenze = Number(s.eingangStilleMin ?? 0);
        if (eingangGrenze > 0 && eingangMin !== null && eingangMin > eingangGrenze)
          problems.push(`seit ${eingangMin} Min kein eingehendes Ereignis (Grenze ${eingangGrenze})`);

        const zustellungMin = altMin(d.letzteZustellung);
        const zustellungGrenze = Number(s.zustellungStilleMin ?? 0);
        if (zustellungGrenze > 0 && zustellungMin !== null && zustellungMin > zustellungGrenze)
          problems.push(`seit ${zustellungMin} Min keine Zustellung (Grenze ${zustellungGrenze})`);

        // Stau und DLQ: hier zaehlt die HOEHE, nicht das erste Vorkommnis.
        const stauGrenze = Number(s.retryStau ?? 25);
        if (Number(d.retryStau) > stauGrenze)
          problems.push(`Retry-Stau: ${d.retryStau} Ereignisse warten auf Wiederholung (Grenze ${stauGrenze})`);
        const dlqGrenze = Number(s.dlqTiefe ?? 10);
        if (Number(d.dlqTiefe) > dlqGrenze)
          problems.push(`DLQ-Tiefe ${d.dlqTiefe} (Grenze ${dlqGrenze}) — Nachrichten liegen unzugestellt`);

        // Schattenbetrieb: NUR die gefaehrliche Richtung alarmiert. `v2_strenger`
        // ist die gewollte Richtung, und ein Melder, der bei gewolltem Verhalten
        // rot wird, wird bald ignoriert.
        const laxerGrenze = Number(s.schattenLaxer ?? 0);
        if (Number(d.schatten?.laxer24h ?? 0) > laxerGrenze)
          problems.push(`Schattenbetrieb: ${d.schatten.laxer24h} Faelle, in denen V2 LAXER war als der Bestand`);

        if (Number(d.kanaele?.fehlerhaft ?? 0) > 0)
          problems.push(`${d.kanaele.fehlerhaft} von ${d.kanaele.gesamt} Kanaelen fehlerhaft oder ohne Autorisierung`);

        if (Number(d.haengendeOnboardings ?? 0) > 0)
          problems.push(`${d.haengendeOnboardings} Onboarding-Sitzung(en) seit ueber 14 Tagen offen`);
      }
    } catch (e) {
      problems.push(`Betriebszahlen nicht abrufbar (${String(e.message).slice(0, 80)})`);
    }
  }

  return { ok: problems.length === 0, problems, bereit: b,
           gesund: gesund?.body ?? null, betrieb: betrieb?.body ?? null };
}

export default async function handler(req, res) {
  // Auth: Vercel-Cron sendet "Authorization: Bearer <CRON_SECRET>". Manuell: ?key=<CRON_SECRET>.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const manual = req.query?.key && req.query.key === secret;
  if (secret && auth !== `Bearer ${secret}` && !manual) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // G4: Konfiguration laden und VALIDIEREN. Eine ungueltige Konfiguration darf nicht
  // zu stillem Betrieb fuehren -- ein Melder, der nichts prueft, ist schlimmer als keiner.
  let konfiguration;
  try {
    konfiguration = ladeKonfiguration();
  } catch (e) {
    return res.status(500).json({ error: "config-invalid", detail: String(e.message).slice(0, 800) });
  }

  // Genau eine Organisation je Aufruf. Standard ist die erste; ?org=<id> waehlt gezielt.
  // Getrennte Laeufe statt Sammellauf: so kann ein Alarm der einen Organisation die
  // andere weder verzoegern noch faelschlich betreffen.
  const gewuenscht = req.query?.org;
  const org = gewuenscht
    ? konfiguration.organisationen.find((o) => o.id === gewuenscht)
    : konfiguration.organisationen[0];
  if (!org) {
    return res.status(404).json({ error: "unknown-org", bekannt: konfiguration.organisationen.map((o) => o.id) });
  }
  const aktiv = (name) => (org.pruefungen || []).includes(name);

  const n8nUrl = org.n8nUrl || process.env.N8N_URL;
  // n8n wird nur verlangt, wenn auch etwas darauf geprueft wird. V2 laeuft als eigener
  // Dienst; ohne diese Unterscheidung waere die Installation gar nicht ueberwachbar.
  const brauchtN8n = (org.pruefungen || []).some((p) => BRAUCHT_N8N.includes(p));
  if (brauchtN8n && !n8nUrl)
    return res.status(500).json({ error: "config-invalid", detail: "n8nUrl fehlt fuer " + org.id });
  const [n8n, execErrors, ingestion, replyGap, zernio, v2, kanalWirkung] = await Promise.all([
    aktiv("n8n_erreichbar")  ? checkN8n(n8nUrl)                 : { skipped: true, reason: "nicht konfiguriert" },
    aktiv("workflow_fehler") ? checkExecutionErrors(n8nUrl, org) : { skipped: true, reason: "nicht konfiguriert" },
    aktiv("ingestion")       ? checkIngestion(org)               : { skipped: true, reason: "nicht konfiguriert" },
    aktiv("antwort_stau")    ? checkReplyGap(org)                : { skipped: true, reason: "nicht konfiguriert" },
    aktiv("provider_webhook")? checkZernio(org)                  : { skipped: true, reason: "nicht konfiguriert" },
    aktiv("v2_bereitschaft") ? checkV2Bereit(org)                : { skipped: true, reason: "nicht konfiguriert" },
    aktiv("kanal_wirkung")   ? checkKanalWirkung(org)            : { skipped: true, reason: "nicht konfiguriert" },
  ]);

  const problems = [];
  // Zernio zuerst: die einzige Auskunft, die kein Rückschluss ist. Sagt Zernio
  // "Webhook aus", ist die Ursache damit benannt, nicht nur das Symptom.
  for (const p of zernio.problems || []) problems.push(`ZERNIO: ${p}`);
  // Der wichtigste Melder zuerst nach Zernio: arbeitet der Kanal, oder nimmt er nur an?
  // Das ist die Frage, die am 17.09.2026 niemand gestellt hat.
  for (const b of kanalWirkung.befunde || []) problems.push(`KANAL STUMM — ${b.text}`);
  // Dann die Stille — der gefährlichste, weil komplett lautlose Ausfall. Je Kanal.
  for (const t of ingestion.tote || []) {
    problems.push(`INGESTION TOT (${t.kanal}): seit ${t.ageHours}h keine eingehende Kundennachricht (letzte ${t.lastInbound}) — auf diesem Kanal kommt nichts mehr an.`);
  }
  if (ingestion.reason === "keine Accounts in DB") {
    problems.push("INGESTION: keine Accounts in der Datenbank gefunden — Pipeline oder Zugang prüfen.");
  }
  // Ein Melder, der wegen eines abgelaufenen Schlüssels nichts sieht, muss das sagen.
  if (execErrors.blind) {
    problems.push(`MELDER BLIND: ${execErrors.note}`);
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
  for (const p of v2.problems || []) problems.push(`V2: ${p}`);
  // Test-Trigger: ?simulate=down erzwingt einen Alarm (Alarm-Weg-Test).
  if (req.query?.simulate === "down") problems.push("TEST-ALARM (simulate=down) — kein echtes Problem, nur Alarm-Weg-Test.");

  // Alarm-Entprellung: Zustand kommt vom Aufrufer (GitHub-Action) via Query.
  const fp = computeFingerprint({ ingestion, n8n, execErrors, replyGap, zernio, v2, kanalWirkung }, problems.length > 0);
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
    const subject = "🚨 " + (org?.alarm?.betreffProblem || "Automation: PROBLEM");
    const body = [
      "Der Watchdog hat ein Problem erkannt:",
      "",
      ...problems.map((p) => "• " + p),
      "",
      "Was zu tun ist:",
      ...naechsteSchritte({ zernio, ingestion, n8n, execErrors, replyGap, kanalWirkung }),
      "",
      `Zeit: ${new Date().toISOString()}`,
      "(Gemeldet wird erst, wenn ein Problem zweimal hintereinander auftaucht — diese",
      "Meldung stand also mindestens 5 Minuten an. Wiederholung frühestens in 2h.)",
    ].join("\n");
    const [email, tg] = await Promise.all([sendEmail(subject, body, org), sendTelegram(subject + "\n\n" + body, org)]);
    alerted = { problem: true, email, telegram: tg };
  } else if (action === "resolved") {
    const subject = "✅ " + (org?.alarm?.betreffOk || "Automation: wieder OK");
    const body = [
      "Entwarnung — die Automation läuft wieder normal.",
      "",
      `Letzter Eingang: ${ingestion.lastInbound || "?"}`,
      `Offene KI-Chats: ${replyGap.stuckCount ?? 0}`,
      "",
      `Zeit: ${new Date().toISOString()}`,
    ].join("\n");
    const [email, tg] = await Promise.all([sendEmail(subject, body, org), sendTelegram(subject + "\n\n" + body, org)]);
    alerted = { resolved: true, email, telegram: tg };
  } else if (notifyOff) {
    alerted = { suppressed: true };
  }

  return res.status(200).json({
    checkedAt: new Date().toISOString(),
    kanalWirkung,
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

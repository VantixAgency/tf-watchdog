// G4 — Validiertes Monitoring-Konfigurationsschema je Installation.
//
// Warum es das gibt: Der Watchdog trug vier Workflow-IDs, einen Match-String,
// feste Alarmempfaenger und einen Anbieternamen fest im Code. Ein zweiter Mandant
// waere damit unueberwacht geblieben — bei einem System, dessen Kernversprechen
// "kein Lead geht verloren" lautet.
//
// Keine freien Regex, keine ausfuehrbaren Ausdruecke. Nur typisierte Werte.
// Secrets stehen NICHT in dieser Konfiguration, sondern ausschliesslich in
// Umgebungsvariablen — die Konfiguration nennt nur deren NAMEN.

/** Erlaubte Pruefungen. Eine Organisation darf nur hieraus waehlen. */
export const PRUEFUNGEN = [
  'n8n_erreichbar', 'workflow_fehler', 'ingestion', 'provider_webhook',
  'antwort_stau', 'queue_tiefe', 'link_erreichbarkeit',
  // V2 laeuft nicht auf n8n, sondern als eigener Dienst. Der Melder fragt dessen
  // Bereitschaftsendpunkt ab -- und zwar nicht nur "antwortet er", sondern auch, ob
  // die Sicherheitsmerkmale noch stehen: alle Migrationen angewendet, keine Tabelle
  // ohne RLS, echte Auth-Kette aktiv, Benutzerkontext verdrahtet. Ein Melder, der nur
  // auf HTTP 200 prueft, wuerde eine stillschweigend abgeschaltete Absicherung
  // durchgehen lassen.
  'v2_bereitschaft',
  // Misst je Studio UND Kanal, ob wirklich geantwortet wird — nicht nur, ob die
  // Anlage lebt. Ohne diese Pruefung bleibt der haeufigste Ausfall unsichtbar:
  // ein einzelner Kanal steht, waehrend alle anderen Melder gruen sind, weil die
  // anderen Kanaele weiterlaufen (Vorfall WhatsApp Muenchen, 17.09.2026).
  'kanal_wirkung',
];

/** Grenzen fuer Schwellwerte. Schuetzt vor Konfigurationsfehlern, die Melder taub machen. */
export const GRENZEN = {
  fehlerFensterMin:   { min: 5,  max: 1440, default: 30 },
  fehlerSchwelle:     { min: 1,  max: 100,  default: 4 },
  ingestStaleStunden: { min: 1,  max: 168,  default: 36 },
  providerFehler:     { min: 1,  max: 50,   default: 3 },
  stauAnzahl:         { min: 1,  max: 100,  default: 2 },
  stauHartMin:        { min: 5,  max: 1440, default: 60 },
  ladeFensterMin:     { min: 5,  max: 1440, default: 25 },
  erinnerungSek:      { min: 300, max: 86400, default: 7200 },
  // Kanal-Wirkung. Die Obergrenzen sind bewusst eng: ein Fenster von Tagen oder eine
  // Mindestmenge von Hunderten machen den Melder faktisch taub, ohne ihn abzuschalten —
  // und ein tauber Melder, der gruen leuchtet, ist genau der Zustand vom 17.09.2026.
  wirkungFensterMin:     { min: 30, max: 720, default: 180 },
  wirkungMindestEingang: { min: 3,  max: 50,  default: 5 },
  wirkungPausenAnteil:   { min: 50, max: 100, default: 70 },
};

/** Kanaele, die ueberwacht werden duerfen. Keine freien Werte — der Name geht direkt in eine Abfrage. */
export const KANAELE = ['instagram', 'whatsapp'];

/** Diese Pruefungen brauchen eine n8n-Instanz. Alle anderen kommen ohne aus. */
export const BRAUCHT_N8N = ['n8n_erreichbar', 'workflow_fehler'];

const istText = (v) => typeof v === 'string' && v.trim().length > 0;
const istIdListe = (v) => Array.isArray(v) && v.every((x) => istText(x?.id) && istText(x?.bezeichnung));

/**
 * Prueft eine Organisationskonfiguration. Gibt { ok, fehler[] } zurueck.
 * Wirft nie — der Aufrufer entscheidet, ob ein Fehler fatal ist.
 */
export function pruefeOrganisation(org, index = 0) {
  const f = [];
  const wo = (feld) => `organisationen[${index}].${feld}`;

  if (!istText(org?.id)) f.push(`${wo('id')} fehlt oder ist leer`);
  else if (!/^[a-z0-9][a-z0-9_-]{1,38}$/.test(org.id))
    f.push(`${wo('id')} muss klein, alphanumerisch, 2–39 Zeichen sein`);
  if (!istText(org?.anzeigename)) f.push(`${wo('anzeigename')} fehlt`);
  if (org?.n8nUrl !== undefined && !/^https:\/\/[a-z0-9.-]+(\/|$)/i.test(String(org.n8nUrl)))
    f.push(`${wo('n8nUrl')} ist keine https-URL`);
  if (org?.v2Url !== undefined && !/^https:\/\/[a-z0-9.-]+(\/|$)/i.test(String(org.v2Url)))
    f.push(`${wo('v2Url')} ist keine https-URL`);
  // Ein Melder ohne Ziel prueft nichts und meldet trotzdem "ok". Das ist der
  // gefaehrlichste Zustand ueberhaupt, deshalb ist er ein Konfigurationsfehler.
  if ((org?.pruefungen ?? []).includes('v2_bereitschaft') && !istText(org?.v2Url))
    f.push(`${wo('v2Url')} fehlt, obwohl v2_bereitschaft geprueft werden soll`);

  // Kanalliste: nur bekannte Werte. Der Kanalname wird in eine PostgREST-Abfrage
  // eingesetzt; ein freier Wert waere eine offene Tuer und ein stiller Fehlmelder.
  if (org?.kanaele !== undefined) {
    if (!Array.isArray(org.kanaele) || org.kanaele.length === 0)
      f.push(`${wo('kanaele')} muss eine nicht-leere Liste sein`);
    else for (const k of org.kanaele)
      if (!KANAELE.includes(k)) f.push(`${wo('kanaele')}: "${k}" ist kein bekannter Kanal`);
  }
  if ((org?.pruefungen ?? []).includes('kanal_wirkung') && org?.kanaele === undefined)
    f.push(`${wo('kanaele')} fehlt, obwohl kanal_wirkung geprueft werden soll — sonst raet der Melder, welche Kanaele es gibt`);

  if (!istIdListe(org?.kritischeWorkflows))
    f.push(`${wo('kritischeWorkflows')} muss eine Liste aus {id, bezeichnung} sein`);
  else if (org.kritischeWorkflows.length === 0)
    f.push(`${wo('kritischeWorkflows')} ist leer — die Organisation waere unueberwacht`);

  if (!Array.isArray(org?.pruefungen) || org.pruefungen.length === 0)
    f.push(`${wo('pruefungen')} fehlt oder ist leer`);
  else {
    for (const p of org.pruefungen)
      if (!PRUEFUNGEN.includes(p)) f.push(`${wo('pruefungen')}: "${p}" ist keine bekannte Pruefung`);
  }

  // Alarmempfaenger: mindestens einer, und Andy-Faelle (Studio-Kontakt) sind erlaubt.
  const e = org?.alarm ?? {};
  const hatEmpfaenger = (Array.isArray(e.email) && e.email.length > 0)
    || (Array.isArray(e.telegramChatIds) && e.telegramChatIds.length > 0);
  if (!hatEmpfaenger) f.push(`${wo('alarm')}: kein Empfaenger — Alarme gingen ins Leere`);
  for (const a of e.email ?? [])
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) f.push(`${wo('alarm.email')}: "${a}" ist keine Adresse`);
  for (const c of e.telegramChatIds ?? [])
    if (!/^-?\d{5,}$/.test(String(c))) f.push(`${wo('alarm.telegramChatIds')}: "${c}" ist keine Chat-ID`);

  // Schwellwerte innerhalb der Grenzen
  for (const [k, g] of Object.entries(GRENZEN)) {
    const v = org?.schwellen?.[k];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) { f.push(`${wo(`schwellen.${k}`)} ist keine Zahl`); continue; }
    if (v < g.min || v > g.max)
      f.push(`${wo(`schwellen.${k}`)}=${v} liegt ausserhalb ${g.min}–${g.max}`);
  }

  // Secrets duerfen NUR als Variablenname auftauchen, nie als Wert.
  for (const [feld, wert] of Object.entries(org?.secretRefs ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(String(wert)))
      f.push(`${wo(`secretRefs.${feld}`)} muss ein Umgebungsvariablen-NAME sein, kein Wert`);
  }

  return { ok: f.length === 0, fehler: f };
}

/** Prueft die gesamte Konfiguration inkl. Eindeutigkeit der Organisations-IDs. */
export function pruefeKonfiguration(cfg) {
  const f = [];
  if (!Array.isArray(cfg?.organisationen) || cfg.organisationen.length === 0) {
    return { ok: false, fehler: ['organisationen fehlt oder ist leer'] };
  }
  const ids = new Set();
  cfg.organisationen.forEach((org, i) => {
    const r = pruefeOrganisation(org, i);
    f.push(...r.fehler);
    if (org?.id) {
      if (ids.has(org.id)) f.push(`organisationen: id "${org.id}" kommt mehrfach vor`);
      ids.add(org.id);
    }
  });

  // Cross-Tenant-Schutz: eine Workflow-ID darf nur EINER Organisation gehoeren.
  const besitzer = new Map();
  cfg.organisationen.forEach((org) => {
    for (const w of org?.kritischeWorkflows ?? []) {
      if (besitzer.has(w.id) && besitzer.get(w.id) !== org.id) {
        f.push(`Workflow ${w.id} ist zwei Organisationen zugeordnet ` +
               `("${besitzer.get(w.id)}" und "${org.id}") — Cross-Tenant-Alarm moeglich`);
      }
      besitzer.set(w.id, org.id);
    }
  });

  return { ok: f.length === 0, fehler: f };
}

/** Fuellt fehlende Schwellwerte mit den Vorgaben. Aendert die Eingabe nicht. */
export function mitVorgaben(org) {
  const schwellen = { ...org.schwellen };
  for (const [k, g] of Object.entries(GRENZEN)) {
    if (schwellen[k] === undefined) schwellen[k] = g.default;
  }
  return { ...org, schwellen };
}

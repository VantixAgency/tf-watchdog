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
};

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

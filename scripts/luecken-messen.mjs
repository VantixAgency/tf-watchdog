#!/usr/bin/env node
// Luecken der Watchdog-Kette messen (Masterplan 16.10.2026, W8). Nur lesend.
//
//   node scripts/luecken-messen.mjs [--seit 2026-10-16T14:00:00Z] [--repo VantixAgency/tf-watchdog]
//
// Liest per `gh api` alle Laeufe von watchdog.yml seit dem Zeitpunkt, holt je Lauf
// started_at/completed_at des Jobs (NICHT createdAt des Laufs — der enthaelt die
// Wartezeit in der Warteschlange, Messfehler vom 15.10.) und gibt die Luecken
// zwischen Jobende und naechstem Jobstart aus. Ziel laut Plan: keine > 3 min.
import { execFileSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const repo = arg('--repo', 'VantixAgency/tf-watchdog');
const seit = arg('--seit', new Date(Date.now() - 48 * 3600e3).toISOString());
const gh = (pfad) => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', pfad], { encoding: 'utf8', maxBuffer: 64e6 }));

export function luecken(jobs, jetzt = Date.now()) {
  const j = jobs.filter((x) => x.start != null).sort((a, b) => a.start - b.start);
  const out = [];
  let ende = null;
  for (const x of j) {
    if (ende !== null && x.start > ende) out.push({ von: ende, bis: x.start, min: (x.start - ende) / 60e3 });
    ende = Math.max(ende ?? 0, x.ende ?? jetzt);
  }
  if (ende !== null && ende < jetzt) out.push({ von: ende, bis: jetzt, min: (jetzt - ende) / 60e3, offen: true });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seiten = gh(`repos/${repo}/actions/workflows/watchdog.yml/runs?per_page=100&created=>=${seit}`);
  const laeufe = seiten.flatMap((s) => s.workflow_runs);
  const jobs = [];
  for (const l of laeufe) {
    for (const s of gh(`repos/${repo}/actions/runs/${l.id}/jobs?per_page=100`)) {
      for (const job of s.jobs) {
        jobs.push({ lauf: l.id, event: l.event, start: job.started_at ? Date.parse(job.started_at) : null,
          ende: job.completed_at ? Date.parse(job.completed_at) : null });
      }
    }
  }
  const l = luecken(jobs);
  const gross = l.filter((x) => x.min > 3);
  const dispatch = laeufe.filter((x) => x.event === 'workflow_dispatch').length;
  console.log(`Laeufe seit ${seit}: ${laeufe.length} (davon workflow_dispatch: ${dispatch})`);
  console.log(`Groesste Luecke: ${l.length ? Math.max(...l.map((x) => x.min)).toFixed(1) : 0} min`);
  for (const x of gross) console.log(`  > 3 min: ${new Date(x.von).toISOString()} -> ${new Date(x.bis).toISOString()} (${x.min.toFixed(1)} min${x.offen ? ', laeuft noch' : ''})`);
  process.exit(gross.length ? 1 : 0);
}

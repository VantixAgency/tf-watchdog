// SNAPSHOT des Live-Node-Codes aus n8n jmKYSADWCfHFQyqr / Node "Health Check".
// Gezogen 2026-08-25 nach dem Flughoehen-Fix + der Ladefenster-Korrektur.
// Dient dem Paritaetstest (test/node-paritaet.test.js) und dem E2E-Test
// (test/health-check-e2e.test.js), der diesen Code wirklich ausfuehrt.
// NICHT importierbar (n8n-Globals) - die Tests extrahieren bzw. wrappen ihn.


function buildOffWindows(events) {
  const evs = (events || [])
    .filter(e => e && (e.type === 'ai_global_off' || e.type === 'ai_global_on'))
    .map(e => ({ type: e.type, ts: Date.parse(e.created_at) }))
    .filter(e => !isNaN(e.ts))
    .sort((a, b) => a.ts - b.ts);
  const windows = [];
  let open = null;
  for (const e of evs) {
    if (e.type === 'ai_global_off') {
      if (open === null) open = { off: e.ts, on: null };
      // doppelte off ohne on: erstes off behalten
    } else { // ai_global_on
      if (open !== null) { open.on = e.ts; windows.push(open); open = null; }
      // on ohne offenes off: ignorieren
    }
  }
  if (open !== null) windows.push(open);
  return windows;
}

function tsInAnyOffWindow(tsMs, windows, nowMs) {
  for (const w of (windows || [])) {
    const end = (w.on === null || w.on === undefined) ? nowMs : w.on;
    if (tsMs >= w.off && tsMs < end) return true;
  }
  return false;
}

function fmtBerlin(tsMs) {
  try {
    return new Date(tsMs).toLocaleTimeString('de-DE',
      { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return new Date(tsMs).toISOString().slice(11, 16); }
}

function planKiNotifications({ slug, name, events, nowMs, state, escalateAfterMs }) {
  const st = Object.assign({ lastOffTs: null, lastOnTs: null, escalatedOffTs: null }, state || {});
  const notes = [];
  const studio = name || slug;
  const windows = buildOffWindows(events);
  const last = windows.length ? windows[windows.length - 1] : null;

  // 1) Neues OFF (jüngstes Fenster, dessen off-Ts wir noch nicht gemeldet haben)
  if (last && last.off !== st.lastOffTs && (st.lastOffTs === null || last.off > st.lastOffTs)) {
    notes.push({ level: 'info', kind: 'off',
      text: `${studio}-KI wurde im Dashboard ausgeschaltet (${fmtBerlin(last.off)}). Neue DMs werden nicht automatisch beantwortet.` });
    st.lastOffTs = last.off;
    st.escalatedOffTs = null; // neues Fenster -> Eskalation wieder erlauben
  }

  // 2) Eskalation: offenes Fenster älter als Schwelle, noch nicht eskaliert
  if (last && last.on === null && (nowMs - last.off) >= escalateAfterMs && st.escalatedOffTs !== last.off) {
    notes.push({ level: 'warn', kind: 'escalation',
      text: `${studio}-KI ist seit über 1 Std aus (${fmtBerlin(last.off)}). Falls unbeabsichtigt: im Dashboard wieder aktivieren.` });
    st.escalatedOffTs = last.off;
  }

  // 3) Neues ON (jüngstes geschlossenes Fenster, dessen on wir noch nicht gemeldet haben)
  const lastClosed = [...windows].reverse().find(w => w.on !== null);
  if (lastClosed && lastClosed.on !== st.lastOnTs && (st.lastOnTs === null || lastClosed.on > st.lastOnTs)) {
    notes.push({ level: 'info', kind: 'on',
      text: `${studio}-KI wieder aktiv (${fmtBerlin(lastClosed.on)}).` });
    st.lastOnTs = lastClosed.on;
  }

  return { notes, state: st };
}

function summarizeNotes(notes) {
  if (!notes || notes.length === 0) return { info: false, subject: '', text: '' };
  const hasEscalation = notes.some(n => n.kind === 'escalation');
  const prefix = hasEscalation ? '⚠️' : 'ℹ️';
  return {
    info: true,
    subject: prefix + ' Tattoo Fashion KI-Status',
    text: notes.map(n => (n.level === 'warn' ? '⚠️ ' : 'ℹ️ ') + n.text).join('\n'),
  };
}

const url=$env.SUPABASE_URL,key=$env.SUPABASE_SERVICE_ROLE_KEY,httpRequest=this.helpers.httpRequest;
const h={apikey:key,Authorization:'Bearer '+key};
async function q(p){ return await httpRequest({method:'GET',url:url+'/rest/v1/'+p,headers:h,json:true,timeout:8000}); }
const now=Date.now();
const iso=(ms)=>new Date(ms).toISOString();
const EVT_WINDOW=now-15*60*1000, ANSWER_FLOOR=now-90*60*1000 /*FIX 2026-08-25: 30->90 Min. Die neue Liegenbleiber-Regel meldet einen EINZELNEN Chat ab 60 Min. Mit dem alten 30-Min-Ladefenster haette sie NIE greifen koennen: die ausloesende Kundennachricht waere da laengst aus dieser Abfrage gefallen. Damit waere die Einzelfall-Meldung ersatzlos abgeschaltet gewesen — genau das Blindloch, das der Umbau vermeiden sollte. REGEL: dieses Fenster muss immer groesser bleiben als FLUGHOEHE.dmHardMin. Geprueft in test/health-check-e2e.test.js.*/, ANSWER_CEIL=now-7*60*1000 /*FIX 2026-06-11: 4->7min, KI buffert Nachrichtenbursts; 4min war zu eng -> vorzeitige 'unbeantwortet'-Alarme*/;

const accounts=await q('accounts?select=id,slug,display_name,ki_global_on,zernio_account_id');
const live=accounts.filter(a=>a.zernio_account_id);
const sd=$getWorkflowStaticData('global'); sd.lastAlert=sd.lastAlert||{};
const problems=[]; const allNotes=[];

for(const a of live){
  // FIX 2026-06-11: ki_global_on=false wird NICHT mehr hier alarmiert. Owner ist der
  // Self-Heal-Watchdog (aN9yDA7rqNUWeTDX): erkennt + heilt in <5 Min + mailt selbst.
  // Doppel-Alarm vermieden. (Quelle des Aus ist das Dashboard/App, kein DB-Trigger.)

  const evs=await q('events?account_id=eq.'+a.id+'&created_at=gte.'+encodeURIComponent(iso(EVT_WINDOW))+'&type=in.(ai_skipped_render_fail,ai_replied_failed,send_failed)&select=type,chat_id,created_at,payload&order=created_at.desc');
  // FIX 2026-06-10 (Net-A): benigne Render-Skips (nichts Beantwortbares, z.B. Story-Reaktion/
  // leere Nachricht) NICHT alarmieren. Echte Render-Fails + ai_replied_failed + send_failed bleiben.
  // 'human-took-over' ist KEIN Fehler — es ist die Uebernahme, die korrekt funktioniert:
  // ein Mensch hat geantwortet, die KI haelt sich raus. Genau so soll es sein.
  // (14.07.: Der erste echte Takeover in Landshut loeste prompt einen "Verarbeitungsfehler"-
  // Alarm aus. Wer bei korrektem Verhalten Alarm schlaegt, erzieht dazu, Alarme zu ignorieren.)
  const BENIGN_SKIP=new Set(['no-usable-messages','empty-buffer-after-cutoff','human-took-over']);

  // FIX 2026-07-14 (Promise: "73% deiner Alarme sind Rauschen"): Fehler, die sich SELBST GEHEILT
  // haben, nicht mehr melden. Gemessen 13.06.-13.07.: von 84 ai_replied_failed haben sich 61 (73%)
  // binnen 15 Minuten selbst repariert — der Retry lief durch, der Kunde bekam seine Antwort.
  // Beispiel 13.07. 10:41: Metas Graph-API warf einen 500er, 14 Sekunden spaeter war die Kundin
  // beantwortet. Der Alarm ging trotzdem raus. Wer staendig grundlos geweckt wird, ueberliest
  // irgendwann den echten Alarm.
  // Regel: Kam im selben Chat NACH dem Fehler ein ai_replied, ist der Fehler erledigt.
  const okEvs=await q('events?account_id=eq.'+a.id+'&created_at=gte.'+encodeURIComponent(iso(EVT_WINDOW))+'&type=eq.ai_replied&select=chat_id,created_at&order=created_at.desc');
  const geheilt=(e)=>{
    if(e.type!=='ai_replied_failed'&&e.type!=='send_failed') return false;
    const t=Date.parse(e.created_at);
    return okEvs.some(o=>o.chat_id===e.chat_id&&Date.parse(o.created_at)>=t);
  };

  const realEvs=evs.filter(e=>
    (e.type!=='ai_skipped_render_fail'||!BENIGN_SKIP.has(((e.payload||{}).skip_reason)||''))
    && !geheilt(e));
  if(realEvs.length){
    const byType={}; realEvs.forEach(e=>byType[e.type]=(byType[e.type]||0)+1);
    const p0=realEvs[0].payload||{}; const reason=p0.skip_reason||p0.error||p0.notify_reason||'';
    problems.push({slug:a.slug,name:a.display_name||a.slug,kind:'Verarbeitungsfehler',errorCount:realEvs.length,detail:Object.entries(byType).map(([t,n])=>t+' x'+n).join(', ')+(reason?(' | '+reason):'')});
  }

  // FIX 2026-06-15 (Promise): KI fuer diesen Account global AUS (ki_global_on=false, Dashboard/Staff).
  // Dann sind unbeantwortete Kunden-DMs die ERWARTETE Folge, KEIN KI-Ausfall -> KEIN 'Unbeantwortete DMs'-Alarm.
  // Owner der KI-Aus-Meldung ist der Watchdog aN9yDA7rqNUWeTDX (meldet den an->aus-Uebergang einmalig).
  // KI-off/on events for this account (Task 2 Part A+B)
  const offEvents=await q('events?account_id=eq.'+a.id+'&created_at=gte.'+encodeURIComponent(iso(ANSWER_FLOOR))+'&type=in.(ai_global_off,ai_global_on)&select=type,created_at&order=created_at.asc');
  // Part A: plan KI-status notifications (off / escalation / on)
  sd.kioff=sd.kioff||{};
  const kiPlan=planKiNotifications({slug:a.slug,name:a.display_name||a.slug,events:offEvents,nowMs:now,state:sd.kioff[a.slug]||{},escalateAfterMs:3600000});
  sd.kioff[a.slug]=kiPlan.state;
  allNotes.push(...kiPlan.notes);
  if(a.ki_global_on===false){ continue; }
  const msgs=await q('messages?account_id=eq.'+a.id+'&created_at=gte.'+encodeURIComponent(iso(ANSWER_FLOOR))+'&select=chat_id,direction,source,created_at,text,attachment_url&order=created_at.asc');
  const byChat={}; for(const m of msgs){(byChat[m.chat_id]=byChat[m.chat_id]||[]).push(m);}
  const chatIds=Object.keys(byChat); let flags={};
  if(chatIds.length){ const fl=await q('chats?id=in.('+chatIds.join(',')+')&select=id,ai_enabled,ai_paused'); fl.forEach(c=>flags[c.id]=c); }
  let stuck=0; const sc=[]; let oldestStuckMin=0;
  for(const cid of chatIds){
    const f=flags[cid]; if(!f||f.ai_enabled===false||f.ai_paused===true) continue;
    const list=byChat[cid];
    // FIX 2026-06-10 (Net-B): nur BEANTWORTBARE Inbounds zaehlen. Contentlose Nachrichten
    // (text null UND kein Attachment, z.B. Story-Reaktion/geteilter Reel) sind nicht beantwortbar
    // und duerfen nicht als 'unbeantwortete DM' alarmieren.
    const hasContent=(m)=>(typeof m.text==='string'&&m.text.trim()!=='')||(m.attachment_url!=null&&m.attachment_url!=='');
    const inbs=list.filter(m=>m.direction==='in'&&m.source==='customer'&&Date.parse(m.created_at)<=ANSWER_CEIL&&hasContent(m));
    if(!inbs.length) continue;
    const lastInMs=Date.parse(inbs[inbs.length-1].created_at);
    const replied=list.some(m=>m.direction==='out'&&Date.parse(m.created_at)>lastInMs);
    // Part B: inbound during a KI-off window is expected-unanswered — do NOT count as stuck
    const win=buildOffWindows(offEvents);
    if(!replied&&!tsInAnyOffWindow(lastInMs,win,now)){ stuck++; sc.push(cid.slice(0,8));
      // FIX 2026-08-25: Alter mitfuehren -> ein einzelner Liegenbleiber (>=60 Min) bleibt
      // meldepflichtig, ein frisch wartender Chat nicht.
      oldestStuckMin=Math.max(oldestStuckMin,Math.round((now-lastInMs)/60000)); }
  }
  if(stuck>0) problems.push({slug:a.slug,name:a.display_name||a.slug,kind:'Unbeantwortete DMs',stuckCount:stuck,oldestStuckMin:oldestStuckMin,detail:stuck+' Chat(s) ohne KI-Antwort, aeltester seit '+oldestStuckMin+' Min ('+sc.slice(0,6).join(', ')+')'});
}

// ===== FLUGHOEHE (FIX 2026-08-25) =====
// Promise: "ich will keine Meldungen mehr von Nicht-Ausfaellen." Ausloeser war die
// Meldung vom 25.08. 10:30 ueber EINEN Muenchner Chat, der 7 Min wartete, waehrend die
// Pipeline nachweislich lief (n8n 200, Ingestion 0 h, Zernio aktiv, Poll fehlerfrei,
// andere Chats beantwortet). Ein wartender Chat ist Alltag: Studio-Uebernahme,
// Message-Request eines Nicht-Followers, Kunde schreibt in Bursts.
// Gemeldet wird ab jetzt der STAU (mehrere gleichzeitig), der LIEGENBLEIBER (einer ueber
// einer Stunde) und die FEHLER-HAEUFUNG - und erst, wenn das Problem zwei Laeufe
// hintereinander (6 Min) zu sehen ist. Dieselbe Flughoehe hat der externe Watchdog
// am 11.08.2026 bekommen; die beiden Melder sind damit konsistent.
// Quelle + 14 Tests: ~/tf-watchdog/n8n/alarm-flughoehe.js ("npm test").
// Bewusst eine KOPIE - n8n-Code-Nodes koennen nicht importieren. Aenderungen dort UND hier.
const FLUGHOEHE={dmStuckCount:3,dmHardMin:60,errorCount:3,requireConsecutive:true,cooldownMs:30*60*1000};
function istAusfall(p,o){
  if(!p||typeof p!=='object') return false;
  if(p.kind==='Unbeantwortete DMs') return (Number(p.stuckCount)||0)>=o.dmStuckCount||(Number(p.oldestStuckMin)||0)>=o.dmHardMin;
  if(p.kind==='Verarbeitungsfehler') return (Number(p.errorCount)||0)>=o.errorCount;
  return true; // unbekannte Problemklassen nie still schlucken
}
function planAlerts(probs,nowMs,state,o){
  const lastAlert=Object.assign({},state.lastAlert||{}), prevPending=Object.assign({},state.pending||{}), pending={};
  const send=[], suppressed=[];
  for(const p of probs){
    const key=p.slug+'|'+p.kind;
    if(!istAusfall(p,o)){ suppressed.push(Object.assign({},p,{grund:'kein Ausfall (unter Schwelle)'})); continue; }
    // ?? statt ||: ein Zeitstempel 0 ist falsy, aber ein gueltiges "schon gesehen".
    pending[key]=prevPending[key]??nowMs;
    if(o.requireConsecutive&&prevPending[key]===undefined){ suppressed.push(Object.assign({},p,{grund:'erst einmal gesehen (wartet auf Bestaetigung)'})); continue; }
    const last=lastAlert[key];
    if(last!==undefined&&nowMs-last<=o.cooldownMs){ suppressed.push(Object.assign({},p,{grund:'Cooldown laeuft'})); continue; }
    lastAlert[key]=nowMs; send.push(p);
  }
  return {send:send,suppressed:suppressed,state:{lastAlert:lastAlert,pending:pending}};
}
sd.pending=sd.pending||{};
const plan=planAlerts(problems,now,{lastAlert:sd.lastAlert,pending:sd.pending},FLUGHOEHE);
sd.lastAlert=plan.state.lastAlert; sd.pending=plan.state.pending;
const fresh=plan.send;

// Build KI-status info items (Part A / Task 3)
// FIX 2026-08-25: reine Zustands-Infos ("KI wurde im Dashboard ausgeschaltet" /
// "wieder aktiv") sind keine Ausfaelle und gehen nicht mehr raus - das steht im
// Dashboard. Die Eskalation bleibt: eine seit ueber einer Stunde ausgeschaltete KI
// laesst echte Kundenanfragen liegen.
const sum=summarizeNotes(allNotes.filter(n=>n&&n.kind==='escalation'));
// Build alarm items (existing logic)
const items=[];
if(fresh.length>0){
  const lines=fresh.map(p=>'• '+p.name+': '+p.kind+' — '+p.detail);
  const when=new Date(now).toLocaleString('de-DE',{timeZone:'Europe/Berlin'});
  const alarmText='🚨 Tattoo Fashion — KI antwortet nicht\n\n'+lines.join('\n')+'\n\nZeit: '+when+'\nDashboard: tattoo-fashion-dashboard.vercel.app';
  items.push({json:{send:true,alert:true,text:alarmText,subject:'🚨 Tattoo Fashion KI-Ausfall ('+fresh.map(p=>p.slug).join(',')+')'}}); }
if(sum.info){
  items.push({json:{send:true,info:true,text:sum.text,subject:sum.subject}}); }
if(items.length===0) return [{json:{send:false,alert:false,checked:live.map(a=>a.slug).join(','),suppressed:plan.suppressed.length,zurueckgehalten:plan.suppressed.map(p=>p.slug+' | '+p.kind+' | '+p.detail+' -> '+p.grund)}}];
return items;

// Rezumatul zilnic pe email: follow-up-uri restante, clienți cu pasul scadent, vânzările de ieri, stoc sub minim.
// Rulează din GitHub Actions (.github/workflows/digest.yml). Variabile de mediu:
//   FIREBASE_SERVICE_ACCOUNT  – JSON-ul cheii de serviciu (secret)
//   RESEND_API_KEY            – cheia Resend (secret)
//   MAIL_FROM                 – ex. "Vivid Senses <notificari@vividsenses.ro>" (domeniu verificat în Resend)
//   APP_URL                   – adresa aplicației
//   DRY_RUN=1                 – afișează emailurile fără să le trimită
import admin from 'firebase-admin';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const fs = admin.firestore();

const DEF = { vat: 21, micro: 1, shareSite: 50, shareAgent: 50, shareEmag: 0, payFee: 1.9, emagFee: 21 };
const FU = [[3, 'Apel ziua 3'], [10, 'Vizită ziua 10'], [21, 'Decizie ziua 21']];
const CH = { site: 'Site', agent: 'Agent', emag: 'eMAG' };
const n2 = v => Number.isFinite(+v) ? +v : 0;
const lei = v => n2(v).toLocaleString('ro-RO', { maximumFractionDigits: 0 }) + ' lei';
// Ziua de azi în fusul orar al României
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date());
const addDays = (d, k) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const yesterday = addDays(today, -1);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const all = async c => (await fs.collection(c).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const [users, products, clients, samples, sales, salesEmag, moves, settingsDoc] = await Promise.all([
  all('users'), all('products'), all('clients'), all('samples'), all('sales'), all('salesEmag'), all('moves'), fs.doc('settings/main').get()
]);
const st = { ...DEF, ...(settingsDoc.exists ? settingsDoc.data() : {}) };
const P = Object.fromEntries(products.map(p => [p.id, p]));
const C = Object.fromEntries(clients.map(c => [c.id, c]));
const pname = id => { const p = P[id]; return p ? [p.name, p.size ? p.size + ' ml' : ''].filter(Boolean).join(' ') : 'produs'; };

function saleCalc(s) {
  let gross = 0, cogs = 0;
  for (const l of s.lines || []) { gross += n2(l.qty) * n2(l.unitPrice); cogs += n2(l.qty) * n2(l.unitCost); }
  const net = gross / (1 + st.vat / 100);
  const fees = s.channel === 'emag' ? gross * st.emagFee / 100 : s.channel === 'site' ? gross * st.payFee / 100 : 0;
  const np = net - cogs - fees - n2(s.ship) - net * st.micro / 100;
  const sh = s.channel === 'site' ? st.shareSite : s.channel === 'agent' ? st.shareAgent : st.shareEmag;
  return { gross, np, partner: np * sh / 100 };
}
function stockOf(pid) {
  let q = 0;
  for (const m of moves) if (m.productId === pid) q += n2(m.qty);
  for (const s of [...sales, ...salesEmag]) for (const l of s.lines || []) if (l.productId === pid) q -= n2(l.qty);
  for (const s of samples) if (s.productId === pid) q -= n2(s.qty || 1);
  return q;
}

// Ce e de făcut
const tasks = [];
for (const s of samples) {
  if (s.outcome) continue;
  FU.forEach(([d, lab], i) => { if (s['f' + i]) return; const due = addDays(s.date, d); if (due <= today) tasks.push({ due, who: s.by, text: `${(C[s.clientId] || {}).name || 'Client'} · ${lab} (${pname(s.productId)})` }); });
}
for (const c of clients) if (c.nextDate && c.nextDate <= today && c.stage !== 'pierdut' && c.stage !== 'client') tasks.push({ due: c.nextDate, who: c.by, text: `${c.name} · ${c.nextText || 'următorul pas'}` });
// Încasări: scadente azi sau întârziate (le văd administratorul și cel care a făcut vânzarea)
const fmtD = d => d.split('-').reverse().join('.');
for (const s of [...sales, ...salesEmag]) {
  if (s.paid !== false) continue;
  const due = s.payDue || s.date;
  if (due > today) continue;
  const late = due < today;
  tasks.push({ due, who: s.by, only: true, text: `<b style="color:#b4413a">încasare ${late ? 'întârziată' : 'scadentă azi'}</b> · ${esc((C[s.clientId] || {}).name || 'Client')} · ${lei(saleCalc(s).gross)} (vânzare din ${fmtD(s.date)}, scadent ${fmtD(due)})`, raw: true });
}
tasks.sort((a, b) => a.due < b.due ? -1 : 1);

const low = products.filter(p => p.active !== false && n2(p.minStock) > 0 && stockOf(p.id) <= n2(p.minStock));

function render(u) {
  const isAdmin = u.role === 'admin';
  const ySales = (isAdmin ? [...sales, ...salesEmag] : sales).filter(s => s.date === yesterday);
  const rows = ySales.map(s => { const c = saleCalc(s); return `<tr><td>${esc(CH[s.channel] || s.channel)}</td><td>${esc((C[s.clientId] || {}).name || '–')}</td><td>${esc((s.lines || []).map(l => l.qty + '× ' + pname(l.productId)).join(', '))}</td><td align="right">${lei(c.gross)}</td><td align="right">${lei(isAdmin ? c.np : c.partner)}</td></tr>`; }).join('');
  const tot = ySales.reduce((t, s) => { const c = saleCalc(s); return { g: t.g + c.gross, p: t.p + (isAdmin ? c.np : c.partner) }; }, { g: 0, p: 0 });
  const myTasks = tasks.filter(t => isAdmin || !t.only || t.who === u.id);
  const tk = myTasks.slice(0, 30).map(t => t.raw ? `<li>${t.text}</li>` : `<li>${t.due < today ? '<b style="color:#b4413a">întârziat</b> · ' : ''}${esc(t.text)}</li>`).join('');
  const test = !!process.env.TEST_ONLY_ADMIN && isAdmin;
  if (!test && !myTasks.length && !ySales.length && !(isAdmin && low.length)) return null;
  const sec = (t, b) => `<h3 style="font-family:Georgia,serif;font-weight:500;margin:22px 0 8px">${t}</h3>${b}`;
  return `<div style="font-family:Helvetica,Arial,sans-serif;color:#1b1916;max-width:620px">
  <div style="background:#0e0d0c;color:#c9a85f;padding:16px 20px;font-family:Georgia,serif;font-size:20px">Vivid Senses <span style="color:#e9e2d4">· rezumatul zilei</span></div>
  <div style="padding:4px 20px 20px">
  ${myTasks.length ? sec(`De făcut azi (${myTasks.length})`, `<ul style="padding-left:18px;line-height:1.6">${tk}</ul>`) : ''}
  ${ySales.length ? sec(`Vânzările de ieri: ${lei(tot.g)}`, `<table cellpadding="6" style="border-collapse:collapse;font-size:13px;width:100%"><tr style="background:#efede8"><th align="left">Canal</th><th align="left">Client</th><th align="left">Produse</th><th align="right">Vânzare</th><th align="right">${isAdmin ? 'Profit net' : 'Cota ta'}</th></tr>${rows}</table><p style="font-size:13px">${isAdmin ? 'Profit net' : 'Cota ta'} ieri: <b>${lei(tot.p)}</b></p>`) : ''}
  ${test && !myTasks.length && !ySales.length && !low.length ? sec('Email de test', '<p>Totul e legat corect. Azi nu e nimic de făcut, iar ieri nu au fost vânzări. Dimineața primești emailul doar când e ceva de urmărit.</p>') : ''}
  ${isAdmin && low.length ? sec('Stoc sub minim', `<ul style="padding-left:18px">${low.map(p => `<li>${esc(pname(p.id))}: ${stockOf(p.id)} buc.</li>`).join('')}</ul>`) : ''}
  <p style="margin-top:24px"><a href="${esc(process.env.APP_URL || '#')}" style="background:#c9a85f;color:#14120f;padding:10px 16px;text-decoration:none;border-radius:6px;font-weight:600">Deschide aplicația</a></p>
  </div></div>`;
}

let sent = 0;
for (const u of users) {
  if (u.active === false || u.notify === false || !u.email) continue;
  if (process.env.TEST_ONLY_ADMIN && u.role !== 'admin') continue;
  const html = render(u);
  if (!html) continue;
  const n = tasks.filter(t => u.role === 'admin' || !t.only || t.who === u.id).length;
  const subject = `Vivid Senses · ${n} de făcut azi`;
  if (process.env.DRY_RUN) { console.log('---', u.email, subject); console.log(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600)); continue; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [u.email], subject, html })
  });
  if (!r.ok) { console.error('Eroare la', u.email, r.status, await r.text()); process.exitCode = 1; } else sent++;
}
console.log(`Trimise: ${sent}. Sarcini: ${tasks.length}. Vânzări ieri: ${[...sales, ...salesEmag].filter(s => s.date === yesterday).length}.`);

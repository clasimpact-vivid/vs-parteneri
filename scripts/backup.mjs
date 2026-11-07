// Backup săptămânal: toate datele aplicației într-un fișier JSON comprimat, trimis pe emailul administratorilor.
// Variabile de mediu: FIREBASE_SERVICE_ACCOUNT, RESEND_API_KEY, MAIL_FROM.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { gzipSync } from 'node:zlib';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (!sa.project_id) { console.error('Lipsește FIREBASE_SERVICE_ACCOUNT.'); process.exit(1); }
initializeApp({ credential: cert(sa) });
const fs = getFirestore();

const COLS = ['users', 'products', 'moves', 'sales', 'salesEmag', 'clients', 'samples', 'payouts', 'visits', 'posts', 'settings'];
const out = { exportedAt: new Date().toISOString(), project: sa.project_id, data: {} };
for (const c of COLS) {
  const snap = await fs.collection(c).get();
  out.data[c] = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
}
const json = JSON.stringify(out, (k, v) => (v && typeof v.toDate === 'function') ? v.toDate().toISOString() : v);
const gz = gzipSync(Buffer.from(json));
const day = new Date().toISOString().slice(0, 10);
const admins = Object.values(out.data.users).filter(u => u.role === 'admin' && u.active !== false && u.email).map(u => u.email);
const counts = COLS.map(c => `${c}: ${Object.keys(out.data[c]).length}`).join(', ');
if (!admins.length) { console.error('Niciun administrator cu email.'); process.exit(1); }
const r = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: process.env.MAIL_FROM, to: admins, subject: `Vivid Senses · backup ${day}`,
    html: `<p>Backup-ul săptămânal al aplicației Vivid Senses Parteneri e atașat (${(gz.length / 1024).toFixed(0)} KB).</p><p style="font-size:13px;color:#666">${counts}</p><p style="font-size:13px;color:#666">Păstrează emailul. Dacă se pierde ceva din aplicație, din fișierul ăsta se pot reface datele.</p>`,
    attachments: [{ filename: `vivid-senses-backup-${day}.json.gz`, content: gz.toString('base64') }]
  })
});
if (!r.ok) { console.error('Eroare Resend', r.status, await r.text()); process.exit(1); }
console.log('Backup trimis la', admins.join(', '), '·', counts);

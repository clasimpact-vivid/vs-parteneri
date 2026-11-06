// Legătura dintre aplicație și Firebase: autentificare, baza de date (Firestore) și jurnalul de modificări.
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  createUserWithEmailAndPassword, updatePassword } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc, getDoc,
  serverTimestamp, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const CFG = window.VS_CONFIG;
const app = initializeApp(CFG.firebase);
const auth = getAuth(app);
const fs = getFirestore(app);
const ADMIN = (CFG.adminEmails || []).map(e => e.toLowerCase());

const $ = s => document.querySelector(s);
const usersMap = {};
let usersReady = false;
const usersListeners = new Set();

// ---------- ecranul de login ----------
const login = $('#login');
const lf = $('#lf'), le = $('#l-email'), lp = $('#l-pass'), lmsg = $('#l-msg');
function msg(t, ok) { lmsg.textContent = t || ''; lmsg.className = 'lmsg' + (ok ? ' ok' : ''); }
lf.addEventListener('submit', async e => {
  e.preventDefault(); msg('');
  const b = $('#l-btn'); b.disabled = true;
  try { await signInWithEmailAndPassword(auth, le.value.trim(), lp.value); }
  catch (err) {
    msg(err.code === 'auth/too-many-requests' ? 'Prea multe încercări. Încearcă din nou peste câteva minute.'
      : 'Email sau parolă greșită.');
  } finally { b.disabled = false; }
});
$('#l-reset').addEventListener('click', async () => {
  if (!le.value.trim()) { msg('Scrie întâi adresa de email, apoi apasă din nou.'); return; }
  try { await sendPasswordResetEmail(auth, le.value.trim()); msg('Ți-am trimis pe email un link pentru o parolă nouă.', true); }
  catch (e) { msg('Nu am putut trimite emailul. Verifică adresa.'); }
});

// ---------- jurnal ----------
function summ(d) { try { return JSON.stringify(d ?? null).slice(0, 1800); } catch (e) { return ''; } }
async function audit(action, path, data) {
  try {
    await addDoc(collection(fs, 'audit'), { ts: serverTimestamp(), day: new Date().toISOString().slice(0, 10),
      by: auth.currentUser.uid, action, path, data: summ(data) });
  } catch (e) { console.warn('jurnal', e); }
}

// ---------- adaptorul bazei de date (aceeași interfață pe care o folosește aplicația) ----------
const wrapSnap = s => ({ docs: s.docs.map(d => ({ id: d.id, data: () => d.data() })) });
const db = {
  collection: p => ({
    onSnapshot: (cb, err) => onSnapshot(collection(fs, p), s => cb(wrapSnap(s)), err),
    add: async d => { const r = await addDoc(collection(fs, p), d); audit('adăugat', p + '/' + r.id, d); return { id: r.id }; }
  }),
  doc: p => {
    const ref = doc(fs, ...p.split('/'));
    return {
      onSnapshot: (cb, err) => onSnapshot(ref, d => cb({ exists: d.exists(), data: () => d.data() }), err),
      set: async d => { await setDoc(ref, d); audit('modificat', p, d); },
      update: async d => { await updateDoc(ref, d); audit('modificat', p, d); },
      delete: async () => {
        let before = null; try { before = (await getDoc(ref)).data(); } catch (e) {}
        await deleteDoc(ref); audit('șters', p, before);
      }
    };
  }
};

// ---------- utilizatori ----------
function initials(n) { return (n || '?').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase(); }
function avatar(n) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" rx="28" fill="#c9a85f"/><text x="28" y="35" font-family="Georgia,serif" font-size="22" text-anchor="middle" fill="#0e0d0c">${initials(n)}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
let meRec = null;
const user = {
  me: async () => meRec,
  profiles: async ids => Object.fromEntries(ids.map(i => [i, { name: (usersMap[i] || {}).name || '' }]))
};

// Funcții doar pentru administrator (le folosește fila Setări)
window.VSAdmin = {
  users: () => usersMap,
  onUsers: fn => { usersListeners.add(fn); if (usersReady) fn(usersMap); return () => usersListeners.delete(fn); },
  setUser: (uid, d) => db.doc('users/' + uid).update(d),
  createUser: async ({ email, password, name, role }) => {
    // O a doua instanță Firebase creează contul fără să te deconecteze pe tine.
    const sec = initializeApp(CFG.firebase, 'creare-' + Date.now());
    try {
      const cred = await createUserWithEmailAndPassword(getAuth(sec), email, password);
      await db.doc('users/' + cred.user.uid).set({ name, email: email.toLowerCase(), role, active: true, notify: true, mustChange: true, created: new Date().toISOString().slice(0, 10) });
      await signOut(getAuth(sec));
      return cred.user.uid;
    } finally { await deleteApp(sec); }
  },
  resetPassword: email => sendPasswordResetEmail(auth, email),
  changePassword: p => updatePassword(auth.currentUser, p),
  auditFeed: (cb, err) => onSnapshot(query(collection(fs, 'audit'), orderBy('ts', 'desc'), limit(400)),
    s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), err),
  logout: () => signOut(auth)
};

// ---------- parolă nouă obligatorie la prima intrare ----------
function forceNewPassword(u) {
  return new Promise(resolve => {
    const f = $('#pwf'), p1 = $('#pw1'), p2 = $('#pw2'), m = $('#pw-msg'), b = $('#pw-btn');
    lf.hidden = true; f.hidden = false; login.hidden = false; document.body.classList.add('locked');
    const say = t => { m.textContent = t; m.className = 'lmsg'; };
    f.onsubmit = async e => {
      e.preventDefault();
      if (p1.value.length < 8) return say('Parola trebuie să aibă minimum 8 caractere.');
      if (p1.value !== p2.value) return say('Cele două parole nu sunt la fel.');
      b.disabled = true;
      try {
        await updatePassword(u, p1.value);
        await updateDoc(doc(fs, 'users', u.uid), { mustChange: false });
        f.hidden = true; lf.hidden = false; p1.value = p2.value = '';
        resolve(true);
      } catch (err) {
        if (err && err.code === 'auth/requires-recent-login') {
          await signOut(auth); f.hidden = true; lf.hidden = false;
          msg('Intră din nou cu parola primită, apoi alegi parola nouă.'); resolve(false);
        } else say('Nu s-a salvat. Încearcă din nou.');
      } finally { b.disabled = false; }
    };
    setTimeout(() => p1.focus(), 50);
  });
}

// ---------- pornire ----------
let started = false;
onAuthStateChanged(auth, async u => {
  if (!u) { if (started) location.reload(); login.hidden = false; document.body.classList.add('locked'); return; }
  const isAdminEmail = ADMIN.includes((u.email || '').toLowerCase());
  const ref = doc(fs, 'users', u.uid);
  let rec = null;
  try { const g = await getDoc(ref); rec = g.exists() ? g.data() : null; } catch (e) { console.warn(e); }
  if (!rec && isAdminEmail) {
    rec = { name: CFG.adminName || 'Administrator', email: u.email.toLowerCase(), role: 'admin', active: true, notify: true, created: new Date().toISOString().slice(0, 10) };
    try { await setDoc(ref, rec); } catch (e) { console.warn(e); }
  }
  if (!rec || rec.active === false) {
    msg(rec ? 'Contul tău a fost dezactivat. Vorbește cu Alex.' : 'Contul nu are acces la aplicație. Cere-i lui Alex să te adauge.');
    await signOut(auth); login.hidden = false; return;
  }
  if (rec.mustChange === true) {
    const ok = await forceNewPassword(u);
    if (!ok) return;
  }
  const admin = isAdminEmail || rec.role === 'admin';
  meRec = { id: u.uid, name: rec.name || u.email, email: u.email, avatarUrl: avatar(rec.name || u.email), canEdit: admin, isOwner: admin, notify: rec.notify !== false };
  onSnapshot(collection(fs, 'users'), s => {
    for (const k of Object.keys(usersMap)) delete usersMap[k];
    s.docs.forEach(d => usersMap[d.id] = { id: d.id, ...d.data() });
    usersReady = true; usersListeners.forEach(fn => fn(usersMap));
  }, e => console.warn('users', e));
  login.hidden = true; document.body.classList.remove('locked');
  if (!started) { started = true; window.__vsBridge.user(user); window.__vsBridge.db(db); }
});

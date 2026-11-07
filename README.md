# Vivid Senses Parteneri

Aplicația comună Vivid Senses: clienți (CRM), mostre cu follow-up, vânzări cu împărțirea profitului, produse, stoc, rapoarte, jurnal de modificări, export Excel și decont PDF, rezumat zilnic pe email.

Rulează pe **GitHub Pages** (paginile), **Firebase Authentication** (conturi) și **Firestore** (date). Emailurile pleacă prin **Resend**, dintr-o acțiune GitHub zilnică.

## Cine ce poate face

| | Administrator (Alex) | Partener |
| --- | --- | --- |
| Vede clienți, mostre, vânzări site + agent, produse, stoc, rapoarte | da | da |
| Adaugă și modifică clienți, mostre, vânzări, intrări de stoc | da | da (vânzările doar pe ale lui) |
| Șterge ceva | da | **nu** (blocat în baza de date) |
| Vânzări eMAG | da | **nu le vede** |
| Modifică prețuri, setări, utilizatori | da | nu |
| Jurnalul de modificări | da | nu |

## Instalare (o singură dată)

### 1. Firebase
1. [console.firebase.google.com](https://console.firebase.google.com) → proiectul `vivid-senses-parteneri`.
2. **Authentication → Sign-in method → Email/Password → Enable**.
3. **Authentication → Users → Add user**: creează **întâi contul tău** (`alexandru@vividsenses.ro` + o parolă). Așa nimeni altcineva nu-și poate face cont cu adresa de administrator.
4. **Firestore Database → Rules**: șterge tot, lipește conținutul din `firestore.rules`, apasă **Publish**.
5. **Project settings → Your apps → Web app**: copiază valorile din `firebaseConfig` în `config.js`.

### 2. GitHub Pages
1. GitHub → **New repository** → nume `vs-parteneri` → **Public** (GitHub Pages pe repo privat cere abonament plătit; în cod nu există parole sau chei secrete).
2. **Add file → Upload files**: urcă `index.html`, `config.js`, `firebase-bridge.js`, `firestore.rules`, `README.md` și folderul `scripts`.
3. Fișierul `.github/workflows/digest.yml`: **Add file → Create new file**, scrie numele exact `.github/workflows/digest.yml` și lipește conținutul.
4. **Settings → Pages → Branch: main / (root) → Save**. După 1–2 minute aplicația e la `https://<utilizator>.github.io/vs-parteneri/`.
5. Înapoi în Firebase: **Authentication → Settings → Authorized domains → Add domain** → `<utilizator>.github.io`.

Adresă proprie (opțional), de exemplu `parteneri.vividsenses.ro`: în DNS adaugi un `CNAME` `parteneri` → `<utilizator>.github.io`, apoi în **Settings → Pages → Custom domain** scrii adresa. O adaugi și la Authorized domains în Firebase.

### 3. Prima intrare
1. Deschide aplicația și intră cu contul tău. Devii automat administrator.
2. **Setări → Utilizatori → Adaugă un utilizator**: numele, emailul și o parolă temporară pentru partener, rol **Partener**.
3. Îi trimiți adresa aplicației, emailul și parola temporară. O schimbă din **Setări → Contul meu**.

### 4. Rezumatul zilnic pe email
1. În Resend, domeniul `vividsenses.ro` trebuie să fie verificat.
2. Firebase → **Project settings → Service accounts → Generate new private key** → se descarcă un fișier JSON.
3. GitHub → repo → **Settings → Secrets and variables → Actions**:
   - **Secrets**: `FIREBASE_SERVICE_ACCOUNT` = tot conținutul fișierului JSON; `RESEND_API_KEY` = cheia din Resend.
   - **Variables**: `MAIL_FROM` = `Vivid Senses <notificari@vividsenses.ro>`; `APP_URL` = adresa aplicației.
4. Test: **Actions → Rezumat zilnic pe email → Run workflow**.

Emailul pleacă de luni până sâmbătă dimineața, doar dacă există ceva de făcut sau vânzări în ziua precedentă. Fiecare îl poate opri din **Setări → Contul meu**.

## Fișiere
- `index.html` – aplicația.
- `config.js` – datele proiectului Firebase și emailul administratorului.
- `firebase-bridge.js` – autentificare, bază de date, jurnal.
- `firestore.rules` – cine ce poate face (dacă schimbi emailul administratorului, schimbă-l și aici, și în `config.js`).
- `scripts/digest.mjs` + `.github/workflows/digest.yml` – rezumatul zilnic.

## Funcții adăugate (noiembrie 2026)

- **Decont și plăți:** cota se plătește doar din încasări; registru de plăți, sold, pierdere reportată, impozit reținut, storno pentru retururi.
- **Discount peste limită:** vânzarea partenerului intră „în așteptare” până o aprobă administratorul (Setări → Discount maxim).
- **Facturi Oblio:** din fișa vânzării, „Emite factură în Oblio”; factura se emite în maximum 30 de minute (workflow `sync.yml`).
- **Comenzi Shopify automat:** la fiecare 30 de minute (workflow `sync.yml`).
- **Teren:** vizite, postări, plan vs. realizat, reumpleri estimate, stoc pe depozit / mașină, ofertă PDF.
- **Offline și pe telefon:** aplicația se instalează pe ecranul telefonului și salvează fără semnal.
- **Backup:** în fiecare luni, pe emailul administratorului (workflow `backup.yml`).

### Secrete și variabile noi (GitHub → Settings → Secrets and variables → Actions)
| Nume | Tip | Ce e |
| --- | --- | --- |
| `SHOPIFY_SHOP` | Variable | numele magazinului, fără `.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Secret | din Dev Dashboard → aplicația ta → Settings |
| `SHOPIFY_CLIENT_SECRET` | Secret | idem |
| `OBLIO_EMAIL` | Secret | emailul de login Oblio |
| `OBLIO_SECRET` | Secret | Oblio → Setări → Date cont → API secret |

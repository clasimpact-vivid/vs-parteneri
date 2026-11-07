// Sincronizare automată, rulată din GitHub Actions (.github/workflows/sync.yml):
//  1) comenzile de pe site din Shopify → vânzări „Site” (încasat / ramburs neîncasat, retururi ca storno);
//  2) facturile cerute din aplicație („Emite factură în Oblio”) → emise în Oblio, cu numărul și linkul salvate înapoi.
// Fiecare parte rulează doar dacă are secretele ei. Variabile de mediu:
//   FIREBASE_SERVICE_ACCOUNT
//   SHOPIFY_SHOP (ex. vividsenses, fără .myshopify.com) + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET  (sau SHOPIFY_TOKEN)
//   OBLIO_EMAIL + OBLIO_SECRET
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (!sa.project_id) { console.error('Lipsește FIREBASE_SERVICE_ACCOUNT.'); process.exit(1); }
initializeApp({ credential: cert(sa) });
const fs = getFirestore();

const DEF = { vat: 21, siteShip: 0, oblioCif: '', oblioSeries: '', oblioVat: 'Normala', oblioStock: 0, shopFrom: '2026-11-01' };
const sDoc = await fs.doc('settings/main').get();
const st = { ...DEF, ...(sDoc.exists ? sDoc.data() : {}) };
const n2 = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
const roDay = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Bucharest' });
const todayRO = roDay(new Date().toISOString());
const addDays = (d, k) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };

const products = (await fs.collection('products').get()).docs.map(d => ({ id: d.id, ...d.data() }));
const byShop = Object.fromEntries(products.filter(p => p.shop).map(p => [p.shop, p]));
const bySku = Object.fromEntries(products.filter(p => p.sku).map(p => [String(p.sku).trim(), p]));
const pname = id => { const p = products.find(x => x.id === id); return p ? [p.name, p.kind && p.kind !== 'Difuzor' ? p.kind.toLowerCase() : '', p.size ? p.size + ' ml' : ''].filter(Boolean).join(' ') : 'Produs'; };

// ======================= 1. SHOPIFY =======================
async function shopify() {
  const shop = (process.env.SHOPIFY_SHOP || '').replace(/\.myshopify\.com.*$/, '').replace(/^https?:\/\//, '').trim();
  if (!shop) { console.log('Shopify: fără SHOPIFY_SHOP, sar peste.'); return; }
  let token = process.env.SHOPIFY_TOKEN;
  if (!token) {
    if (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) { console.log('Shopify: lipsesc SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET.'); return; }
    const r = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_CLIENT_SECRET })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) { console.error('Shopify: nu am primit token.', r.status, JSON.stringify(j).slice(0, 300)); process.exitCode = 1; return; }
    token = j.access_token;
  }
  const gql = async (query, variables) => {
    const r = await fetch(`https://${shop}.myshopify.com/admin/api/2025-10/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables })
    });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 500));
    return j.data;
  };
  const Q = `query($q:String,$after:String){orders(first:40,after:$after,query:$q,sortKey:UPDATED_AT){pageInfo{hasNextPage endCursor}nodes{
    legacyResourceId name processedAt cancelledAt test displayFinancialStatus totalShippingPriceSet{shopMoney{amount}}
    customer{displayName} billingAddress{company name city}
    lineItems(first:50){nodes{quantity title variantTitle sku
      discountedUnitPriceAfterAllDiscountsSet{shopMoney{amount}} originalUnitPriceSet{shopMoney{amount}}
      variant{selectedOptions{name value} product{handle}}}}
    transactions(first:20){kind status processedAt}
    refunds(first:20){legacyResourceId createdAt refundLineItems(first:50){nodes{quantity priceSet{shopMoney{amount}}
      lineItem{sku variant{selectedOptions{name value} product{handle}}}}}}
  }}}`;
  const since = addDays(todayRO, -7);
  const q = `created_at:>=${st.shopFrom} updated_at:>=${since}`;
  const match = li => {
    const v = li.variant || {};
    const opt = ((v.selectedOptions || [])[0] || {}).value || '';
    const key = (v.product && v.product.handle ? v.product.handle : '') + '|' + (/^default title$/i.test(opt) ? '' : opt);
    return byShop[key] || (li.sku && bySku[String(li.sku).trim()]) || null;
  };
  let after = null, n = 0, warn = [];
  do {
    const d = await gql(Q, { q, after });
    for (const o of d.orders.nodes) {
      if (o.test) continue;
      const id = 'shop_' + o.legacyResourceId;
      const ref = fs.doc('sales/' + id);
      const prev = await ref.get();
      const fin = o.displayFinancialStatus;
      if (o.cancelledAt && !['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(fin)) { if (prev.exists && !(prev.data().invoice)) await ref.delete(); continue; }
      if (['VOIDED', 'EXPIRED'].includes(fin)) { if (prev.exists && !(prev.data().invoice)) await ref.delete(); continue; }
      const paid = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(fin);
      const tx = (o.transactions || []).filter(t => ['SALE', 'CAPTURE'].includes(t.kind) && t.status === 'SUCCESS').sort((a, b) => a.processedAt < b.processedAt ? 1 : -1)[0];
      const date = roDay(o.processedAt);
      const old = prev.exists ? prev.data() : {};
      const oldCost = Object.fromEntries((old.lines || []).map(l => [l.productId, l.unitCost]));
      const lines = [];
      for (const li of o.lineItems.nodes) {
        const p = match(li);
        if (!p) warn.push(`${o.name}: ${li.title}${li.variantTitle ? ' / ' + li.variantTitle : ''}`);
        lines.push({ productId: p ? p.id : null, name: p ? undefined : li.title, qty: li.quantity,
          unitPrice: n2((li.discountedUnitPriceAfterAllDiscountsSet || li.originalUnitPriceSet).shopMoney.amount),
          unitCost: p ? (oldCost[p.id] ?? n2(p.cost)) : 0 });
      }
      const who = (o.billingAddress && (o.billingAddress.company || o.billingAddress.name)) || (o.customer && o.customer.displayName) || '';
      // Transport: dacă clientul l-a plătit (comenzi sub pragul de livrare gratuită), firma suportă doar diferența până la costul curierului.
      const charged = n2(o.totalShippingPriceSet && o.totalShippingPriceSet.shopMoney.amount);
      const shipCost = Math.max(0, Math.round((n2(st.siteShip) - charged) * 100) / 100);
      const doc = { date, channel: 'site', clientId: old.clientId || null, ship: old.shipManual ? old.ship : shipCost,
        note: `Shopify ${o.name}${who ? ' · ' + who : ''}`, lines: lines.map(l => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined))),
        by: 'shopify', loc: 'depozit', shopId: o.legacyResourceId, paid,
        paidDate: paid ? (tx ? roDay(tx.processedAt) : date) : null, payDue: paid ? null : addDays(date, 7) };
      await ref.set(doc, { merge: true });
      n++;
      for (const rf of o.refunds || []) {
        const items = rf.refundLineItems.nodes;
        if (!items.length) continue;
        const rl = items.map(it => { const p = match(it.lineItem); return { productId: p ? p.id : null, qty: -it.quantity, unitPrice: n2(it.priceSet.shopMoney.amount), unitCost: p ? (oldCost[p.id] ?? n2(p.cost)) : 0 }; });
        const rd = roDay(rf.createdAt);
        await fs.doc('sales/' + id + '_r' + rf.legacyResourceId).set({ date: rd, channel: 'site', clientId: null, ship: 0, note: `Storno Shopify ${o.name}`,
          lines: rl, by: 'shopify', loc: 'depozit', storno: true, refOf: id, paid: true, paidDate: rd }, { merge: true });
      }
    }
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after);
  console.log(`Shopify: ${n} comenzi sincronizate.`);
  if (warn.length) console.log('Produse negăsite în aplicație (verifică exportul / SKU):\n  ' + [...new Set(warn)].join('\n  '));
}

// ======================= 2. OBLIO =======================
async function oblio() {
  const email = process.env.OBLIO_EMAIL, secret = process.env.OBLIO_SECRET;
  const queue = [];
  for (const col of ['sales', 'salesEmag']) {
    const snap = await fs.collection(col).where('invoiceReq', '==', 'pending').get();
    snap.forEach(d => queue.push({ ref: d.ref, s: d.data() }));
  }
  if (!queue.length) { console.log('Oblio: nicio factură de emis.'); return; }
  if (!email || !secret) { for (const q of queue) await q.ref.update({ invoiceReq: null, invoiceErr: 'Oblio nu e conectat (lipsesc OBLIO_EMAIL / OBLIO_SECRET în GitHub).' }); return; }
  if (!st.oblioCif || !st.oblioSeries) { for (const q of queue) await q.ref.update({ invoiceReq: null, invoiceErr: 'Completează în Setări CIF-ul și seria Oblio.' }); return; }
  const tr = await fetch('https://www.oblio.eu/api/authorize/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: email, client_secret: secret }) });
  const tj = await tr.json().catch(() => ({}));
  if (!tj.access_token) { console.error('Oblio: autentificare eșuată', tr.status, JSON.stringify(tj).slice(0, 300)); for (const q of queue) await q.ref.update({ invoiceReq: null, invoiceErr: 'Autentificare Oblio eșuată: verifică emailul și cheia API.' }); process.exitCode = 1; return; }
  for (const { ref, s } of queue) {
    try {
      if ((s.lines || []).some(l => n2(l.qty) < 0)) throw new Error('Returul se facturează din Oblio, ca stornare a facturii inițiale.');
      const c = s.clientId ? ((await fs.doc('clients/' + s.clientId).get()).data() || {}) : {};
      const cui = String(c.cui || '').replace(/\s/g, '');
      const body = {
        cif: st.oblioCif, seriesName: st.oblioSeries, issueDate: todayRO, language: 'RO', currency: 'RON', precision: 2, useStock: n2(st.oblioStock) ? 1 : 0,
        client: { cif: cui, name: c.firm || c.name || 'Persoană fizică', rc: c.regCom || '', address: c.address || '', state: c.county || '', city: c.city || '',
          country: 'Romania', email: c.invEmail || c.email || '', phone: c.phone || '', contact: c.contact || '', vatPayer: /^RO/i.test(cui) ? 1 : 0, save: 1 },
        products: (s.lines || []).map(l => {
          const p = products.find(x => x.id === l.productId) || {};
          return { name: l.productId ? pname(l.productId) : (l.name || 'Produs'), code: p.sku || '', price: n2(l.unitPrice), measuringUnit: 'buc', currency: 'RON',
            vatName: st.oblioVat || 'Normala', vatPercentage: n2(st.vat), vatIncluded: 1, quantity: n2(l.qty), productType: 'Marfa' };
        }),
        mentions: s.note || ''
      };
      const r = await fetch('https://www.oblio.eu/api/docs/invoice', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tj.access_token }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.data && j.data.number) {
        await ref.update({ invoice: { series: j.data.seriesName, number: String(j.data.number), link: j.data.link || '' }, invoiceReq: null, invoiceErr: null });
        console.log('Oblio: factura', j.data.seriesName, j.data.number);
      } else throw new Error(j.statusMessage || ('HTTP ' + r.status));
    } catch (e) {
      console.error('Oblio:', e.message);
      await ref.update({ invoiceReq: null, invoiceErr: String(e.message).slice(0, 300) });
    }
  }
}

try { await shopify(); } catch (e) { console.error('Shopify:', e.message); process.exitCode = 1; }
try { await oblio(); } catch (e) { console.error('Oblio:', e.message); process.exitCode = 1; }

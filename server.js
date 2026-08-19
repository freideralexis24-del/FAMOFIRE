// ============================================================
// FAMOFIRE - Servidor central (LATAM)
// Emparejamiento global, salas de batalla, ranking Top 100
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns');
// Render no tiene ruta IPv6: Gmail SMTP resuelve a IPv6 y falla con ENETUNREACH.
// Forzar resolución IPv4 evita que el envío de correos se muera en el intento.
dns.setDefaultResultOrder('ipv4first');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const { Server } = require('socket.io');

// Carga .env local (SIEMPRE ignorado por git): permite SMTP/Google credenciales
// en desarrollo sin tocarlas en el código. Render define las suyas por panel.
{
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
}

const PORT = process.env.PORT || 3000;
const MATCH_SIZE = 35;                              // cupos por partida (jugadores reales + bots)
const QUEUE_TIMEOUT = parseInt(process.env.MM_TIMEOUT_MS || '15000', 10); // espera máxima en cola (15 s)
const MAP = { w: 3600, h: 2000 };                   // mapa fijo del Campo de Batalla (sincronizado)
const SPAWN_MIN_DIST = 400;                         // distancia mínima entre apariciones
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Fase 1 de escala: config liviana para soportar miles de conexiones.
  maxHttpBufferSize: 1e5,     // mensajes pequeños: nada de payloads gigantes
  perMessageDeflate: false,   // sin compresión por mensaje: menos CPU
  pingInterval: 25000,        // keep-alive relajado
  pingTimeout: 20000,
  connectTimeout: 20000,
});

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.get('/health', (req, res) => res.send('ok'));
// Config pública para el cliente: login con Google y tienda premium.
app.get('/config', (req, res) => res.json({
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  shop: {
    enabled: !!(stripe || mpEnabled),
    provider: (mpEnabled ? 'mp' : (stripe ? 'stripe' : 'none')),
    currency: {
      name: GEM_NAME,
      emoji: GEM_EMOJI,
      img: gemImgUrl()
    },
    packages: Object.entries(GEM_PACKAGES).map(([id, p]) => ({ id, name: p.name, gems: p.gems, priceCOP: p.priceCOP })),
    items: Object.entries(PREMIUM_ITEMS).map(([id, it]) => ({ id, type: it.type, name: it.name, emoji: it.emoji, desc: it.desc, gems: it.gems, color: it.color || '', bg: it.bg || '', anim: it.anim || '' }))
  }
}));

// ---------- Tienda premium (pagos con Stripe Checkout) ----------
// Flujo: el jugador pide el artículo -> se crea una sesión de pago -> Stripe
// cobra en su página -> redirige a /?purchase_ok=1&session_id=... -> el servidor
// verifica el pago (api/stripe-verify) y entrega el artículo a la cuenta.
// Solo se activa si STRIPE_SECRET_KEY existe en el entorno (modo prueba o real).
app.post('/api/stripe-checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(501).json({ ok: false, error: 'stripe-disabled' });
    if (!accountsReady) await ensureAccounts();
    const name = String(((req.body && req.body.name) || '')).trim().toUpperCase().slice(0, 12);
    const itemId = String((req.body && req.body.itemId) || '');
    const acc = name ? accounts[name] : null;
    if (!acc) return res.json({ ok: false, error: 'not-found' });
    const item = PREMIUM_ITEMS[itemId];
    if (!item) return res.json({ ok: false, error: 'bad-item' });
    if ((acc.owns || []).includes(itemId)) return res.json({ ok: false, error: 'already-owned' });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'FAMOFIRE: ' + item.name },
          unit_amount: item.priceCents
        },
        quantity: 1
      }],
      metadata: { itemId, account: name },
      success_url: APP_BASE_URL + '/?purchase_ok=1&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: APP_BASE_URL + '/?purchase_cancel=1'
    });
    res.json({ ok: true, url: session.url });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'stripe-error', msg: String(e.message || e).slice(0, 120) });
  }
});

// Verificar que el pago fue completado y entregar el artículo al comprador.
app.get('/api/stripe-verify', async (req, res) => {
  try {
    if (!stripe) return res.status(501).json({ ok: false, error: 'stripe-disabled' });
    const sessionId = String(req.query.session_id || '');
    if (!sessionId) return res.json({ ok: false, error: 'bad-session' });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') return res.json({ ok: false, error: 'not-paid' });
    const itemId = session.metadata && session.metadata.itemId;
    const accountName = session.metadata && session.metadata.account;
    const item = PREMIUM_ITEMS[itemId];
    if (!item || !accounts[accountName]) return res.json({ ok: false, error: 'bad-metadata' });
    const acc = accounts[accountName];
    const already = (acc.owns || []).includes(itemId);
    if (!already) {
      acc.owns = acc.owns || [];
      acc.owns.push(itemId);
      saveAccounts();
    }
    res.json({ ok: true, already, itemId, name: accountName });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'stripe-error', msg: String(e.message || e).slice(0, 120) });
  }
});
// ---------- Tienda premium (pagos con Mercado Pago, Colombia) ----------
// Flujo: el jugador compra un paquete de GEMAS -> se crea una preferencia -> MP
// muestra su página de pago (tarjeta, PSE, Nequi...) -> redirige a /?mp_ok=1&payment_id=...
// -> el servidor verifica el pago (api/mp-verify) y entrega las gemas a la cuenta.
// Se activa solo si MP_ACCESS_TOKEN existe (TEST- para pruebas, APP_USR- real).
app.post('/api/mp-checkout', async (req, res) => {
  try {
    if (!mpEnabled) return res.status(501).json({ ok: false, error: 'mp-disabled' });
    if (!accountsReady) await ensureAccounts();
    const name = String(((req.body && req.body.name) || '')).trim().toUpperCase().slice(0, 12);
    const packId = String((req.body && req.body.packId) || '');
    const acc = name ? accounts[name] : null;
    if (!acc) return res.json({ ok: false, error: 'not-found' });
    const pack = GEM_PACKAGES[packId];
    if (!pack) return res.json({ ok: false, error: 'bad-pack' });
    const url = await mpCreatePreference(pack, name);
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'mp-error', msg: String(e.message || e).slice(0, 120) });
  }
});

// Comprar un artículo usando GEMAS de la cuenta (la moneda se descuenta aquí,
// la verificación de gems es atómica del lado servidor).
app.post('/api/buy-item', async (req, res) => {
  try {
    if (!accountsReady) await ensureAccounts();
    const name = String(((req.body && req.body.name) || '')).trim().toUpperCase().slice(0, 12);
    const itemId = String((req.body && req.body.itemId) || '');
    const acc = normalizeAcc(name ? accounts[name] : null);
    if (!acc) return res.json({ ok: false, error: 'not-found' });
    const item = PREMIUM_ITEMS[itemId];
    if (!item) return res.json({ ok: false, error: 'bad-item' });
    if ((acc.owns || []).includes(itemId)) return res.json({ ok: false, error: 'already-owned' });
    if ((acc.gems || 0) < item.gems) return res.json({ ok: false, error: 'need-gems', gems: acc.gems || 0 });
    acc.gems -= item.gems;
    acc.owns = acc.owns || [];
    acc.owns.push(itemId);
    saveAccounts();
    res.json({ ok: true, itemId, name, gems: acc.gems });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'buy-error', msg: String(e.message || e).slice(0, 120) });
  }
});

// Entrega lo comprado a la cuenta si el pago de MP fue aprobado.
// Las referencias nuevas son "gems:<packId>:<cuenta>"; se mantiene el formato
// viejo "itemId:cuenta" por si quedaron pagos iniciados con la versión anterior.
async function grantMPPayment(payment) {
  if (!payment || payment.status !== 'approved') return { ok: false, error: 'not-paid', status: payment && payment.status };
  const ref = String(payment.external_reference || '');
  const sep = ref.indexOf(':');
  const head = (sep > 0 ? ref.slice(0, sep) : '');
  const rest = (sep > 0 ? ref.slice(sep + 1) : '');
  if (head === 'gems') {
    const sep2 = rest.indexOf(':');
    const packId = (sep2 > 0 ? rest.slice(0, sep2) : '');
    const accountName = (sep2 > 0 ? rest.slice(sep2 + 1) : '');
    const pack = GEM_PACKAGES[packId];
    const acc = normalizeAcc(accounts[accountName]);
    if (!pack || !acc) return { ok: false, error: 'bad-metadata' };
    acc.gems += pack.gems;
    saveAccounts();
    return { ok: true, gems: pack.gems, packId, name: accountName };
  }
  const itemId = head;
  const accountName = rest;
  const item = PREMIUM_ITEMS[itemId];
  const acc = normalizeAcc(accounts[accountName]);
  if (!item || !acc) return { ok: false, error: 'bad-metadata' };
  const already = (acc.owns || []).includes(itemId);
  if (!already) {
    acc.owns = acc.owns || [];
    acc.owns.push(itemId);
    saveAccounts();
  }
  return { ok: true, already, itemId, name: accountName };
}

// Verificar que el pago fue aprobado por MP y entregar el artículo al comprador.
app.get('/api/mp-verify', async (req, res) => {
  try {
    if (!mpEnabled) return res.status(501).json({ ok: false, error: 'mp-disabled' });
    const paymentId = String(req.query.payment_id || '');
    if (!paymentId) return res.json({ ok: false, error: 'bad-payment' });
    const payment = await mpVerifyPayment(paymentId);
    res.json(await grantMPPayment(payment));
  } catch (e) {
    res.status(500).json({ ok: false, error: 'mp-error', msg: String(e.message || e).slice(0, 120) });
  }
});

// ADMIN (solo el dueño): entrega artículos premium y/o FamoCoins a cualquier
// cuenta por nombre o por ID de soldado. Requiere ADMIN_KEY en el entorno.
app.post('/api/admin-grant', async (req, res) => {
  try {
    const ADMIN_KEY = process.env.ADMIN_KEY || '';
    if (!ADMIN_KEY) return res.status(501).json({ ok: false, error: 'admin-disabled' });
    const key = String((req.body && req.body.key) || '');
    if (key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'forbidden' });
    if (!accountsReady) await ensureAccounts();
    const byName = String(((req.body && req.body.name) || '')).trim().toUpperCase().slice(0, 12);
    const byId = String(((req.body && req.body.id) || '')).trim().toUpperCase();
    let acc = null, accountKey = '';
    if (byName && accounts[byName]) { acc = accounts[byName]; accountKey = byName; }
    else if (byId) {
      const found = Object.keys(accounts).find(k => String(accounts[k].id || '').toUpperCase() === byId);
      if (found) { acc = accounts[found]; accountKey = found; }
    }
    if (!acc) return res.status(404).json({ ok: false, error: 'not-found', id: byId, name: byName || undefined });
    acc = normalizeAcc(acc);
    const wantAll = !!(req.body && req.body.all);
    const wantItems = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const ids = wantAll ? Object.keys(PREMIUM_ITEMS) : wantItems;
    const added = [];
    acc.owns = acc.owns || [];
    ids.forEach(id => {
      if (!PREMIUM_ITEMS[id] || acc.owns.includes(id)) return;
      acc.owns.push(id);
      added.push(id);
    });
    const gems = Number(req.body && req.body.gems);
    if (gems > 0 && Number.isFinite(gems) && gems <= 1000000) acc.gems = (acc.gems || 0) + gems;
    saveAccounts();
    res.json({ ok: true, account: accountKey, id: acc.id, added, ownsCount: acc.owns.length, gems: acc.gems });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'admin-error', msg: String(e.message || e).slice(0, 120) });
  }
});

// ADMIN (solo el dueño): fija valores ABSOLUTOS de una cuenta (saldos, artículos
// e ID único). Pensado para arreglar duplicados: quitar todo a una cuenta clon y
// regenerarle un ID que no colisione con ninguna otra. Requiere ADMIN_KEY.
app.post('/api/admin-set', async (req, res) => {
  try {
    const ADMIN_KEY = process.env.ADMIN_KEY || '';
    if (!ADMIN_KEY) return res.status(501).json({ ok: false, error: 'admin-disabled' });
    const key = String((req.body && req.body.key) || '');
    if (key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'forbidden' });
    if (!accountsReady) await ensureAccounts();
    const byName = String(((req.body && req.body.name) || '')).trim().toUpperCase().slice(0, 12);
    const byId = String(((req.body && req.body.id) || '')).trim().toUpperCase();
    let acc = null, accountKey = '';
    if (byName && accounts[byName]) { acc = accounts[byName]; accountKey = byName; }
    else if (byId) {
      const found = Object.keys(accounts).find(k => String(accounts[k].id || '').toUpperCase() === byId);
      if (found) { acc = accounts[found]; accountKey = found; }
    }
    if (!acc) return res.status(404).json({ ok: false, error: 'not-found', id: byId, name: byName || undefined });
    acc = normalizeAcc(acc);
    if (req.body && req.body.gems !== undefined) {
      const gems = Number(req.body.gems);
      if (Number.isFinite(gems) && gems >= 0 && gems <= 100000000) acc.gems = Math.floor(gems);
    }
    if (req.body && req.body.clearItems === true) acc.owns = [];
    let oldId = acc.id;
    let newId = null;
    if (req.body && req.body.regenerateId === true) {
      newId = uniqueId();
      acc.id = newId;
    }
    if (req.body && req.body.setId) {
      const sid = String(req.body.setId).trim();
      if (!isNewStyleId(sid)) return res.status(400).json({ ok: false, error: 'bad-id-format' });
      const clash = Object.keys(accounts).find(k => k !== accountKey && String(accounts[k].id || '').toUpperCase() === sid.toUpperCase());
      if (clash) return res.status(409).json({ ok: false, error: 'id-taken', by: clash });
      acc.id = sid;
      newId = sid;
    }
    // Vincular un correo para la recuperación de contraseña de cuentas que se
    // crearon con contraseña y NO pasaron por Google (ej. ALEXIS). Si la cuenta
    // no tiene un id de Google, se genera uno interno estable para poder firmar
    // los enlaces de recuperación con el MISMO flujo de Google.
    if (req.body && req.body.email) {
      const em = String(req.body.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return res.status(400).json({ ok: false, error: 'bad-email' });
      acc.googleEmail = em;
      if (!acc.googleId) acc.googleId = 'mail:' + accountKey;
    }
    saveAccounts();
    res.json({ ok: true, account: accountKey, oldId, id: acc.id, newId, gems: acc.gems, ownsCount: acc.owns.length, email: maskEmail(acc.googleEmail) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'admin-error', msg: String(e.message || e).slice(0, 120) });
  }
});

// ADMIN (solo el dueño): lista TODAS las cuentas con su ID actual, monedas y
// última actividad, para auditar la numeración de IDs. Requiere ADMIN_KEY.
// El correo vinculado aparece enmascarado (f***@dominio) para no exponerlo.
function maskEmail(e) {
  if (!e) return '';
  const s = String(e);
  const i = s.indexOf('@');
  if (i <= 1) return s;
  return s[0] + '***' + s.slice(i);
}
app.get('/api/admin-list', async (req, res) => {
  try {
    const ADMIN_KEY = process.env.ADMIN_KEY || '';
    if (!ADMIN_KEY) return res.status(501).json({ ok: false, error: 'admin-disabled' });
    if (String((req.query && req.query.key) || '') !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'forbidden' });
    if (!accountsReady) await ensureAccounts();
    const list = Object.keys(accounts).map(k => {
      const a = normalizeAcc(accounts[k]);
      return { name: k, id: a.id, gems: a.gems || 0, level: a.level, lastSeen: a.lastSeen || 0, email: maskEmail(a.googleEmail), hasGoogle: !!a.googleId };
    }).sort((x, y) => (parseInt(String(x.id), 10) || 0) - (parseInt(String(y.id), 10) || 0));
    res.json({ ok: true, count: list.length, accounts: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'admin-error', msg: String(e.message || e).slice(0, 120) });
  }
});

// NOTA: el endpoint de renumeración masiva de IDs fue ELIMINADO a propósito.
// Los IDs se consideran PERMANENTES: nadie (ni siquiera el admin por clave)
// puede volver a cambiarlos. La única vía es admin-set con setId (una cuenta a
// la vez, solo si hay motivo y respetando que no colisione).

// ADMIN (solo el dueño): regala a un jugador o a TODOS los jugadores un artículo
// (o un simple comunicado sin artículo) por el BUZÓN, con texto largo. Requiere
// ADMIN_KEY. Sin "name" va para todas las cuentas del juego.
app.post('/api/admin-mail', async (req, res) => {
  try {
    const ADMIN_KEY = process.env.ADMIN_KEY || '';
    if (!ADMIN_KEY) return res.status(501).json({ ok: false, error: 'admin-disabled' });
    const key = String((req.body && req.body.key) || '');
    if (key !== ADMIN_KEY) return res.status(403).json({ ok: false, error: 'forbidden' });
    if (!accountsReady) await ensureAccounts();
    const itemId = String((req.body && req.body.itemId) || '');
    if (itemId && !PREMIUM_ITEMS[itemId]) return res.status(400).json({ ok: false, error: 'bad-item' });
    const msg = String((req.body && req.body.msg) || '').slice(0, 1000);
    if (!itemId && !msg.trim()) return res.status(400).json({ ok: false, error: 'empty-mail' });
    const byName = String((req.body && req.body.name) || '').trim().toUpperCase().slice(0, 12);
    let targets = [];
    if (byName) {
      if (!accounts[byName]) return res.status(404).json({ ok: false, error: 'not-found', name: byName });
      targets = [byName];
    } else {
      targets = Object.keys(accounts);
    }
    const now = Date.now();
    const hasItem = !!itemId;
    targets.forEach(t => {
      const acc = accounts[t];
      if (!acc) return;
      acc.mails = acc.mails || [];
      acc.mails.push({
        id: genId(), from: 'FAMOFIRE', to: t,
        itemId: itemId || '', msg,
        sentAt: now, claimed: !hasItem
      });
    });
    saveAccounts();
    try { io.emit('new-mail'); } catch (e) { /* sin sockets conectados */ }
    res.json({ ok: true, sentTo: targets.length, itemId: itemId || null, msgLen: msg.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'admin-error', msg: String(e.message || e).slice(0, 120) });
  }
});

// Webhook de MP: recibe avisos de pago y entrega el artículo aunque el jugador
// no vuelva al juego (el pago ya fue aprobado en el sitio de MP).
app.post('/api/mp-webhook', async (req, res) => {
  try {
    if (!mpEnabled) return res.sendStatus(200);
    const body = req.body || {};
    const pid = String((body.id) || (body.data && body.data.id) || '');
    if (pid && /^\d+$/.test(pid)) {
      const payment = await mpVerifyPayment(pid);
      await grantMPPayment(payment);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('mp-webhook:', e.message || e);
    res.sendStatus(200);
  }
});

// Diagnóstico PÚBLICO (sin secretos): ayuda a resolver instalaciones remotas.
// Solo muestra si las piezas están configuradas, nunca contraseñas ni tokens.
app.get('/diag', async (req, res) => {
  try {
    if (!accountsReady) await ensureAccounts();
    const names = Object.keys(accounts);
    let alexisCount = 0, alexisEmail = 0;
    for (const n of names) {
      if (String(n).toLowerCase().indexOf('alexis') === 0) {
        alexisCount++;
        if (accounts[n].googleEmail) alexisEmail++;
      }
    }
    res.json({
      db: { configured: !!process.env.DATABASE_URL, connected: !!db, accounts: names.length },
      alexis: { cuentas: alexisCount, conEmail: alexisEmail, nombres: names.filter(n => String(n).toLowerCase().indexOf('alexis') === 0) },
      smtp: { configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER), host: process.env.SMTP_HOST || '', user: process.env.SMTP_USER || '', port: Number(process.env.SMTP_PORT) || 587 },
      appUrl: APP_BASE_URL,
      google: { clientId: !!process.env.GOOGLE_CLIENT_ID },
      resetTtlMin: RESET_TTL_MIN
    });
  } catch (e) {
    res.json({ error: 'diag-fail', msg: String(e.message || e).slice(0, 120) });
  }
});

// ---------- Cuentas de jugador (cada persona tiene la suya) ----------
// En la web (Render) las cuentas se guardan en PostgreSQL gratuito (variable
// DATABASE_URL) para que NUNCA se borren con las actualizaciones. En local
// (sin DATABASE_URL) se sigue usando accounts.json.
const DATABASE_URL = process.env.DATABASE_URL || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// Verificación de ID tokens de Google Sign-In (solo se crea si está configurado)
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ---- Recuperación de contraseña por correo (opcional) ----
// Para que FUNCIONE tienes que definir en el entorno de Render:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, RESET_SECRET y APP_URL
// Sin SMTP el resto del juego funciona igual; el enlace de recuperación solo se
// devuelve en la respuesta (para probarlo en local) en vez de enviarse por email.
let transporter = null;
try {
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' },
      // FORZAR IPv4 en la conexión SMTP: evita "connect ENETUNREACH <ipv6>"
      // que ocurre cuando el servidor de correo responde con IPv6 y la red del
      // hosting no tiene ruta (Render/Free y Gmail). Este lookup solo usa IPv4.
      lookup: (host, opts, cb) => dns.lookup(host, Object.assign({}, opts, { family: 4 }), cb)
    });
  }
} catch (e) { transporter = null; }
const RESET_SECRET = process.env.RESET_SECRET || 'famofire-local-reset-secret';
const RESET_TTL_MIN = Math.max(1, parseInt(process.env.RESET_TTL_MINUTES || '30', 10) || 30); // minutos de validez del enlace
const APP_BASE_URL = (process.env.APP_URL || (process.env.RENDER_EXTERNAL_URL ? 'https://' + process.env.RENDER_EXTERNAL_URL : 'http://localhost:3000')).replace(/\/+$/, '');
// Nombre/remitente que ven los jugadores. Con API (Brevo/Resend) DEBE ser un
// remitente verificado en la plataforma para no caer en spam.
const MAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'FAMOFIRE <noreply@famofire.com>';

// ---- Envío por API dedicada (Brevo / Resend) ----
// Preferido frente a SMTP: IPs de envío dedicadas, mejor reputación (menos
// riesgo de spam) y sin problemas de IPv6/ENETUNREACH. Solo se usa si existe
// BREVO_API_KEY o RESEND_API_KEY en el entorno; si no, se cae a SMTP.
function apiMailProvider() {
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.RESEND_API_KEY) return 'resend';
  return null;
}
function mailFromParts() {
  if (typeof MAIL_FROM === 'string' && MAIL_FROM.includes('<')) {
    const m = MAIL_FROM.match(/^(.*?)\s*<([^>]+)>$/);
    if (m) return { name: m[1].trim(), email: m[2].trim() };
  }
  return { name: 'FAMOFIRE', email: MAIL_FROM };
}
async function sendMailViaApi(to, subject, html) {
  const prov = apiMailProvider();
  const from = mailFromParts();
  if (prov === 'brevo') {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: from.name, email: from.email }, to: [{ email: to }], subject, htmlContent: html })
    });
    if (!r.ok) throw new Error('BREVO HTTP ' + r.status + ': ' + String(await r.text()).slice(0, 160));
  } else if (prov === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html })
    });
    if (!r.ok) throw new Error('RESEND HTTP ' + r.status + ': ' + String(await r.text()).slice(0, 160));
  } else {
    throw new Error('sin proveedor de API configurado');
  }
}

// ---- Moneda del juego: FAMOCOINS (estilo diamantes de Free Fire) ----
// El jugador compra FamoCoins con dinero real (Mercado Pago) y con ellas compra
// los artículos de la tienda. También es la moneda que usará LUCKY ROYALE.
const GEM_NAME = 'FamoCoins';
const GEM_EMOJI = '🪙';
// Imagen de la moneda: busca cualquier nombre para que no dependa de uno exacto.
function gemImgUrl() {
  const dir = path.join(__dirname, 'public', 'img');
  for (const f of ['coin.png', 'moneda.png', 'gema.png', 'gemas.png', 'diamante.png']) {
    if (fs.existsSync(path.join(dir, f))) return '/img/' + f;
  }
  return '';
}
// Paquetes de FamoCoins que se compran con Mercado Pago (COP). Ajusta precios aquí.
const GEM_PACKAGES = {
  pack_40:   { name: 'Iniciado',   gems: 40,   priceCOP: 2000 },
  pack_110:  { name: 'Soldado',    gems: 110,  priceCOP: 5000 },
  pack_250:  { name: 'Comandante', gems: 250,  priceCOP: 10000 },
  pack_600:  { name: 'Élite',      gems: 600,  priceCOP: 22000 },
  pack_1300: { name: 'Leyenda',    gems: 1300, priceCOP: 45000 },
  pack_3000: { name: 'Supremo',    gems: 3000, priceCOP: 95000 }
};
// ---- Tienda premium: artículos que se compran con FamoCoins ----
const PREMIUM_ITEMS = {
  skin_fuego:    { type: 'skin',   name: 'Skin Fuego Dorado',      emoji: '🔥', color: '#ffcc00', gems: 110, desc: 'Uniforme dorado de batalla' },
  skin_elite:    { type: 'skin',   name: 'Skin Comandante Élite',  emoji: '🛡️', color: '#8a2be2', gems: 110, desc: 'Uniforme violeta de mando' },
  skin_fantasma: { type: 'skin',   name: 'Skin Fantasma LATAM',    emoji: '👻', color: '#19ffc8', gems: 110, desc: 'Uniforme esmeralda camuflado' },
  banner_royal:  { type: 'banner', name: 'Banner Bandera Real',    emoji: '🏴', gems: 180, desc: 'Marco dorado en tu perfil' },
  avatar_king:   { type: 'avatar', name: 'Avatar Rey',             emoji: '👑', gems: 80,  desc: 'Corona dorada del rey' },
  avatar_genie:  { type: 'avatar', name: 'Avatar Genio',           emoji: '🧞', gems: 80,  desc: 'Genio que concede deseos' },
  avatar_guard:  { type: 'avatar', name: 'Avatar Guardia Real',    emoji: '💂', gems: 80,  desc: 'Guardia de honor del comando' },
  avatar_scorp:  { type: 'avatar', name: 'Avatar Escorpión',       emoji: '🦂', gems: 80,  desc: 'Picadura letal del desierto' },
  // ---- FONDOS premium (se ven animados en tu tarjeta de perfil) ----
  fondo_lagolava:{ type: 'fondo', name: 'Fondo Lago de Lava',      emoji: '🌋', gems: 220, desc: 'La lava sube y baja en tu perfil', bg: 'linear-gradient(160deg, #8a2b0a 0%, #3a1208 60%, #140602 100%)', anim: 'lava' },
  fondo_galaxia: { type: 'fondo', name: 'Fondo Galaxia Infinita',  emoji: '🌌', gems: 220, desc: 'Estrellas que derivan en el espacio', bg: 'radial-gradient(ellipse at 25% 30%, rgba(140,70,230,0.5), transparent 55%), radial-gradient(ellipse at 75% 70%, rgba(0,150,230,0.42), transparent 55%), radial-gradient(circle at 50% 45%, rgba(255,255,255,0.07), transparent 60%), linear-gradient(150deg, #0e0730 0%, #05030f 55%, #04101f 100%)', anim: 'stars' },
  fondo_trueno:  { type: 'fondo', name: 'Fondo Tormenta Eléctrica',emoji: '⚡', gems: 220, desc: 'Rayos que cruzan tu perfil', bg: 'linear-gradient(160deg, #0b1c3a 0%, #06101f 100%)', anim: 'storm' },
  fondo_oro:     { type: 'fondo', name: 'Fondo Oro de Leyenda',    emoji: '👑', gems: 220, desc: 'Brillo dorado de campeón', bg: 'linear-gradient(140deg, #b8860b 0%, #3a2a05 100%)', anim: 'gold' }
};
// Cuentas viejas no tienen gemas: se normalizan al cargar y antes de responder.
function normalizeAcc(acc) {
  if (!acc) return acc;
  if (typeof acc.gems !== 'number' || !isFinite(acc.gems) || acc.gems < 0) acc.gems = 0;
  if (!Array.isArray(acc.owns)) acc.owns = [];
  if (!Array.isArray(acc.mails)) acc.mails = [];
  return acc;
}
// Stripe solo se activa con STRIPE_SECRET_KEY en el entorno (Render). Sin la
// llave el juego funciona igual: la tienda avisa "pronto" y no se cobra nada.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
let stripe = null;
if (STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(STRIPE_SECRET_KEY); } catch (e) { stripe = null; }
}
// Mercado Pago (Colombia): funciona con Access Token de prueba (TEST-) o de
// producción (APP_USR-) vía su API pública REST (sin SDK).
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const mpEnabled = MP_ACCESS_TOKEN.startsWith('TEST-') || MP_ACCESS_TOKEN.startsWith('APP_USR-');
async function mpCreatePreference(pack, accountName) {
  const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ title: 'FAMOFIRE: ' + pack.gems + ' ' + GEM_NAME + ' (' + pack.name + ')', quantity: 1, unit_price: pack.priceCOP, currency_id: 'COP' }],
      back_urls: {
        success: APP_BASE_URL + '/?mp_ok=1',
        pending: APP_BASE_URL + '/?mp_pending=1',
        failure: APP_BASE_URL + '/?mp_cancel=1'
      },
      notification_url: APP_BASE_URL + '/api/mp-webhook',
      // auto_return solo con credenciales de prueba (en producción MP exige https)
      ...(MP_ACCESS_TOKEN.startsWith('TEST-') ? { auto_return: 'approved' } : {}),
      external_reference: 'gems:' + pack.id + ':' + accountName
    })
  });
  const data = await r.json();
  if (!r.ok || !data.init_point) throw new Error('MP ' + r.status + ' ' + String(data.message || 'no init_point').slice(0, 80));
  return data.init_point;
}
async function mpVerifyPayment(paymentId) {
  const r = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(paymentId), {
    headers: { 'Authorization': 'Bearer ' + MP_ACCESS_TOKEN }
  });
  const data = await r.json();
  if (!r.ok || !data || !data.status) throw new Error('MP verify ' + r.status);
  return data;
}
function resetToken(googleId, purpose) {
  return sha(googleId + '|' + purpose + '|' + RESET_SECRET) + '.' + googleId + '.' + purpose + '.' + (Date.now() + RESET_TTL_MIN * 60000);
}
function parseResetToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length === 3) { // enlaces viejos (antes de la expiración): siguen valiendo sin límite
    const sig = parts[0], googleId = parts[1], purpose = parts[2];
    if (sig !== sha(googleId + '|' + purpose + '|' + RESET_SECRET)) return null;
    return { googleId, purpose };
  }
  if (parts.length !== 4) return null;
  const sig = parts[0], googleId = parts[1], purpose = parts[2], expiresAt = Number(parts[3]);
  if (!Number.isFinite(expiresAt)) return null;
  if (sig !== sha(googleId + '|' + purpose + '|' + RESET_SECRET)) return null;
  if (expiresAt < Date.now()) return { googleId, purpose, expired: true };
  return { googleId, purpose };
}
function findAccountByGoogle(sub) {
  for (const [n, a] of Object.entries(accounts)) {
    if (a && a.googleId && a.googleId === sub) return n;
  }
  return null;
}
function findAccountById(id) {
  const target = String(id || '').trim().toUpperCase();
  if (!target) return null;
  for (const [n, a] of Object.entries(accounts)) {
    if (a && String(a.id || '').toUpperCase() === target) return n;
  }
  return null;
}
let db = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
}

let accounts = {};
let accountsReady = false;
let accountsPromise = null;
function ensureAccounts() {
  if (accountsReady) return Promise.resolve();
  if (!accountsPromise) accountsPromise = initAccounts();
  return accountsPromise;
}
async function initAccounts() {
  if (db) {
    try {
      await db.query(
        `CREATE TABLE IF NOT EXISTS accounts (
           name TEXT PRIMARY KEY,
           password TEXT NOT NULL,
           points INT NOT NULL DEFAULT 0,
           level INT NOT NULL DEFAULT 1,
           exp INT NOT NULL DEFAULT 0
         )`);
      try {
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lastseen BIGINT NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS id TEXT');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS google_id TEXT');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS google_email TEXT');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unnamed BOOLEAN NOT NULL DEFAULT FALSE');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS device_token TEXT');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS matches INT NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS wins INT NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kills INT NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dmg INT NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deaths INT NOT NULL DEFAULT 0');
        await db.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS owns TEXT NOT NULL DEFAULT '[]'");
        await db.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mails TEXT NOT NULL DEFAULT '[]'");
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS gems INT NOT NULL DEFAULT 0');
      } catch (e) { /* versión vieja de Postgres u otro problema menor: se ignora */ }
      const { rows } = await db.query('SELECT name, password, points, level, exp, lastseen, id, google_id, google_email, unnamed, device_token, matches, wins, kills, dmg, deaths, owns, mails, gems FROM accounts ORDER BY lastseen ASC');
      accounts = {};
      for (const r of rows) {
        let owns = [];
        if (r.owns) { try { owns = Array.isArray(JSON.parse(r.owns)) ? JSON.parse(r.owns) : []; } catch (e) { owns = []; } }
        let mails = [];
        if (r.mails) { try { mails = Array.isArray(JSON.parse(r.mails)) ? JSON.parse(r.mails) : []; } catch (e) { mails = []; } }
        accounts[r.name] = normalizeAcc({ id: r.id || genAccountId(), password: r.password, points: Number(r.points), level: Number(r.level), exp: Number(r.exp), lastSeen: Number(r.lastseen) || 0, googleId: r.google_id || '', googleEmail: r.google_email || '', unnamed: !!r.unnamed, deviceToken: r.device_token || '', matches: Number(r.matches) || 0, wins: Number(r.wins) || 0, kills: Number(r.kills) || 0, dmg: Number(r.dmg) || 0, deaths: Number(r.deaths) || 0, owns, mails, gems: Number(r.gems) || 0 });
      }
      console.log(`[DB] ${rows.length} cuentas cargadas desde PostgreSQL`);
    } catch (e) {
      console.error('[DB] no se pudo conectar a PostgreSQL:', e.message);
      console.error('[DB] usando accounts.json como respaldo');
      db = null;
    }
  }
  if (!db) {
    try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) { accounts = {}; }
    console.warn('[DB] ⚠️ SIN PostgreSQL: las cuentas se guardan en disco EFÍMERO y se BORRAN en cada actualización.');
    console.warn('[DB] 👉 En Render: crea New > PostgreSQL (plan Free) y pega su Internal Database URL en Environment > DATABASE_URL. Luego actualiza el servicio una vez.');
  }
  // ID único por cuenta (para control de jugadores). Si una cuenta antigua no lo
  // tiene (de la era pre-ID), se le genera uno ahora. NO se borra ninguna cuenta
  // jamás: el espacio ocupado es mínimo y evita pérdidas de cuentas reales.
  // Los IDs YA asignados NUNCA se vuelven a tocar: cualquier renumeración aquí
  // provocaba que cada reinicio de Render cambiara los IDs de los jugadores.
  const seenIds = new Set();
  for (const name of Object.keys(accounts)) {
    const a = accounts[name];
    normalizeAcc(a);
    if (a && a.id) seenIds.add(String(a.id).toUpperCase());
  }
  let backfilled = false;
  for (const name of Object.keys(accounts)) {
    const a = accounts[name];
    if (!a || a.id) continue;
    a.id = genAccountId();
    seenIds.add(String(a.id).toUpperCase());
    backfilled = true;
  }
  if (backfilled) saveAccounts();
  accountsReady = true;
}
function genId() {
  // ID corto y legible (8 caracteres hex) para controlar cada cuenta
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}
function genAccountId() {
  // ID NUMÉRICO PERMANENTE y secuencial: la primera cuenta es 10000000,
  // la siguiente 10000001, 10000002... y así crece de 1 en 1. El ID de una
  // cuenta NUNCA se regenera mientras exista; solo se asigna cuando la cuenta
  // no tiene uno o tiene el formato viejo (hex aleatorio) en la migración.
  let max = 9999999;
  for (const name of Object.keys(accounts)) {
    const a = accounts[name];
    const n = parseInt(String((a && a.id) || ''), 10);
    if (Number.isInteger(n) && n >= 10000000 && n > max) max = n;
  }
  return String(max + 1);
}
function isNewStyleId(id) {
  return /^\d{8,}$/.test(String(id || ''));
}
function uniqueId(taken) {
  // Genera un ID que no esté en uso por NINGUNA otra cuenta
  const set = new Set(taken ? Array.from(taken) : Object.values(accounts).map(a => String(a.id || '').toUpperCase()));
  let id = genId();
  let guard = 0;
  while (set.has(id) && guard++ < 100) id = genId();
  return id;
}
function saveAccounts() {
  if (db) {
    dbSaveAll().catch(e => console.error('[DB] error guardando cuentas:', e.message));
    return;
  }
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts)); } catch (e) { /* sin permiso de escritura en algunos hosts */ }
}
async function dbSaveAll() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS owns TEXT NOT NULL DEFAULT \'[]\'');
    const q = `INSERT INTO accounts (name, id, password, points, level, exp, lastseen, google_id, google_email, unnamed, device_token, matches, wins, kills, dmg, deaths, owns, mails, gems)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
               ON CONFLICT (name) DO UPDATE SET
                 id = EXCLUDED.id,
                 password = EXCLUDED.password,
                 points = EXCLUDED.points,
                 level = EXCLUDED.level,
                 exp = EXCLUDED.exp,
                 lastseen = EXCLUDED.lastseen,
                 google_id = EXCLUDED.google_id,
                 google_email = EXCLUDED.google_email,
                 unnamed = EXCLUDED.unnamed,
                 device_token = EXCLUDED.device_token,
                 matches = EXCLUDED.matches,
                 wins = EXCLUDED.wins,
                 kills = EXCLUDED.kills,
                 dmg = EXCLUDED.dmg,
                 deaths = EXCLUDED.deaths,
                 owns = EXCLUDED.owns,
                 mails = EXCLUDED.mails,
                 gems = EXCLUDED.gems`;
    for (const [name, a] of Object.entries(accounts)) {
      await client.query(q, [name, a.id || genId(), a.password, Number(a.points) || 0, Number(a.level) || 1, Number(a.exp) || 0, Number(a.lastSeen) || 0, a.googleId || '', a.googleEmail || '', !!a.unnamed, a.deviceToken || '', Number(a.matches) || 0, Number(a.wins) || 0, Number(a.kills) || 0, Number(a.dmg) || 0, Number(a.deaths) || 0, JSON.stringify(a.owns || []), JSON.stringify(a.mails || []), Number(a.gems) || 0]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignorar */ }
    throw e;
  } finally {
    client.release();
  }
}
function sha(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
// El Top es SOLO para jugadores con puntos reales ganados en partidas (0 puntos = no aparece)
function getTop100() {
  return Object.entries(accounts)
    .filter(([, a]) => a && (Number(a.points) || 0) > 0)
    .map(([name, a]) => ({
      name, points: a.points || 0, level: a.level || 1,
      matches: a.matches || 0, wins: a.wins || 0, kills: a.kills || 0,
      dmg: a.dmg || 0, deaths: a.deaths || 0
    }))
    .sort((x, y) => y.points - x.points)
    .slice(0, 100);
}

// Copia servidor de la fórmula de experiencia del cliente (nivel -> exp requerida)
function getRequiredExp(lvl) {
  if (lvl >= 100) return 999999;
  return Math.floor(100 + lvl * 60);
}

// Puntos y experiencia CALCULADOS POR EL SERVIDOR (misma fórmula que el cliente,
// pero el servidor es la autoridad: un cliente tramposo ya no puede otorgarse puntos).
function computeRewards(placement, kills, damageDealt) {
  let basePlacementPoints = 0;
  if (placement >= 15) {
    basePlacementPoints = Math.round(-100 * ((placement - 15) / 20));
  } else {
    basePlacementPoints = Math.round(120 - ((placement - 1) * (115 / 13)));
  }
  let rankPointsChange = basePlacementPoints + (kills * 5) + Math.floor(damageDealt / 50);
  if (placement === 1) rankPointsChange += 30;
  const expEarned = (placement === 1 ? 70 : Math.max(15, 55 - placement)) + (kills * 15);
  return { rankPointsChange, expEarned };
}

// Aplica las recompensas a la cuenta del jugador y devuelve los totales oficiales.
function applyRewards(acc, placement, kills, damageDealt) {
  const { rankPointsChange, expEarned } = computeRewards(placement, kills, damageDealt);
  acc.points = clamp((Number(acc.points) || 0) + rankPointsChange, 0, 999999);
  acc.matches = (Number(acc.matches) || 0) + 1;
  if (placement === 1) acc.wins = (Number(acc.wins) || 0) + 1;
  acc.kills = (Number(acc.kills) || 0) + Math.max(0, kills);
  acc.dmg = (Number(acc.dmg) || 0) + Math.max(0, damageDealt);
  let level = Number(acc.level) || 1;
  let exp = (Number(acc.exp) || 0) + expEarned;
  let required = getRequiredExp(level);
  while (exp >= required && level < 100) {
    exp -= required;
    level++;
    required = getRequiredExp(level);
  }
  acc.level = level;
  acc.exp = level >= 100 ? 0 : exp;
  acc.lastSeen = Date.now();
  return { pointsEarned: rankPointsChange, expEarned, points: acc.points, level: acc.level, exp: acc.exp, matches: acc.matches || 0, wins: acc.wins || 0, kills: acc.kills || 0, dmg: acc.dmg || 0, deaths: acc.deaths || 0 };
}

// ---------- Utilidades ----------
const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

// ---------- Cola de emparejamiento ----------
const queue = [];
// Candado de sesión única: cada cuenta (con contraseña o Google) solo puede
// estar abierta en UNA pestaña/página a la vez. La segunda se rechaza con
// 'acct-already-open' hasta que la primera se desconecte.
const accountLocks = new Map();
let queueTimer = null;
let queueDeadline = 0; // ms (Date.now()) en que arranca la partida: COMPARTIDA para toda la cola
let queueStartAt = 0;  // momento en que entró el primer jugador de la cola (espera solitaria)
const MIN_QUEUE_START = 2;   // con 2+ jugadores la partida sale a la hora prevista
const SOLO_MAX_WAIT = 20000; // jugador solo espera máximo 20 s (después entra contra bots)

// Difunde a TODOS los de la cola el mismo tiempo restante y el contador:
// así un jugador que se une a mitad de espera ve la misma cuenta atrás que
// el primero (antes cada uno veía sus propios 15s locales y no coincidían).
function broadcastQueueStatus() {
  if (queue.length === 0) return;
  const remaining = Math.max(0, Math.ceil((queueDeadline - Date.now()) / 1000));
  for (const q of queue) {
    const s = q.socket;
    if (s.connected) s.emit('mm-status', { inQueue: true, count: queue.length, remaining: remaining * 1000 });
  }
}
setInterval(broadcastQueueStatus, 500);

// Arranca la partida solo cuando hay al menos MIN_QUEUE_START jugadores reales.
// Con un único jugador esperando, se re-programa la salida hasta SOLO_MAX_WAIT
// para darle tiempo a que entre el/los demás jugadores online a esta misma cola.
function maybeStartMatch() {
  queueTimer = null;
  if (queue.length === 0) { queueDeadline = 0; queueStartAt = 0; return; }
  const waited = queueStartAt ? Date.now() - queueStartAt : 0;
  if (queue.length >= MIN_QUEUE_START || waited >= SOLO_MAX_WAIT) {
    startMatch();
  } else {
    const extra = Math.max(1000, SOLO_MAX_WAIT - waited);
    queueDeadline = Date.now() + extra;
    queueTimer = setTimeout(maybeStartMatch, extra);
    broadcastQueueStatus();
  }
}

function assignSpawns(players) {
  const spawns = [];
  for (const p of players) {
    let x, y, tries = 0;
    do {
      x = rand(300, MAP.w - 300);
      y = rand(300, MAP.h - 300);
      tries++;
    } while (tries < 50 && spawns.some(s => dist2(s.x, s.y, x, y) < SPAWN_MIN_DIST ** 2));
    spawns.push({ x: Math.round(x), y: Math.round(y) });
  }
  return spawns;
}

function startMatch() {
  if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
  queueDeadline = 0;
  const taken = queue.splice(0, MATCH_SIZE);
  if (taken.length === 0) return;

  const roomCode = 'match-' + Date.now() + '-' + Math.floor(Math.random() * 999);
  const spawns = assignSpawns(taken);
  const players = new Map();

  taken.forEach((q, i) => {
    players.set(q.socket.id, {
      id: q.socket.id, name: q.name, color: q.color, skin: q.skin || q.socket.data.skin || '', points: q.points,
      x: spawns[i].x, y: spawns[i].y, angle: 0, alive: true,
      // Estado de combate autoritativo del servidor (anti-trampa):
      // la vida de jugadores reales, el daño aplicado y el escudo viven aquí.
      hp: 100, kills: 0, dmg: 0, shieldUntil: 0, lastHitAt: 0, deadAck: false, deathTimer: null,
    });
    q.socket.data.room = roomCode;
    q.socket.join(roomCode);
  });

  const match = { code: roomCode, players, aliveCount: players.size, endedAt: 0 };
  matches.set(roomCode, match);

  const assignedBotsCount = Math.max(0, MATCH_SIZE - players.size);
  // Zona de veneno sincronizada para TODOS los jugadores de la partida:
  // cierra casi del todo en un punto aleatorio del mapa (no siempre al centro)
  const zone = {
    x: MAP.w / 2,
    y: MAP.h / 2,
    startX: MAP.w / 2,
    startY: MAP.h / 2,
    targetX: Math.round(rand(MAP.w * 0.20, MAP.w * 0.80)),
    targetY: Math.round(rand(MAP.h * 0.20, MAP.h * 0.80)),
    maxRadius: Math.hypot(MAP.w, MAP.h) * 1.2,
    targetRadius: 120,
    startDelay: 900,
    duration: 5760,
  };
  const payload = {
    mapW: MAP.w,
    mapH: MAP.h,
    assignedBotsCount,
    matchId: roomCode,
    zone,
    you: null,
    players: [...players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, skin: p.skin || '', x: p.x, y: p.y })),
  };

  for (const p of players.values()) {
    const s = io.sockets.sockets.get(p.id);
    if (!s) continue;
    s.emit('match-start', { ...payload, you: { x: p.x, y: p.y } });
  }
  console.log(`[MATCH] Partida ${roomCode} iniciada con ${players.size} jugador(es) reales + ${assignedBotsCount} bots`);
}

// ---------- Partidas activas ----------
const matches = new Map();

// clientPlacement: posición reportada por el cliente (cuenta los bots, que son locales).
// El servidor la usa con tope inferior = muertos reales + 1, así un tramposo no puede
// reportar una posición mejor que la que le corresponde entre jugadores reales.
// clientKills: bajas a bots reportadas por el cliente, acotadas (no puede inflarlas
// más allá de 40 + las bajas reales verificadas por el servidor).
function endMatchFor(match, loserId, clientPlacement, clientKills) {
  const p = match.players.get(loserId);
  if (!p || !p.alive) return;
  if (p.deathTimer) { clearTimeout(p.deathTimer); p.deathTimer = null; }
  p.alive = false;
  match.aliveCount = [...match.players.values()].filter(q => q.alive).length;
  io.to(match.code).emit('remove-player', { matchId: match.code, id: loserId });
  io.to(match.code).emit('update-room-alive', match.aliveCount);

  const order = [...match.players.values()].filter(q => !q.alive).length;
  const fallback = Math.max(1, match.players.size - order + 1);
  const placement = Math.max(order + 1, Math.min(35, Math.floor(num(clientPlacement, fallback))));
  io.to(match.code).emit('kill-feed', { matchId: match.code, killer: p.killedBy || 'Zona', victim: p.name });
  const loserSocket = io.sockets.sockets.get(loserId);
  if (loserSocket) {
    // Recompensas OFICIALES del servidor: bajas reales (verificadas) + bajas a bots
    // reportadas (acotadas) + daño real aplicado por el servidor.
    const botKills = Math.max(0, Math.floor(num(clientKills, 0)));
    const totalKills = Math.min((p.kills || 0) + botKills, (p.kills || 0) + 40);
    const winPayload = { matchId: match.code, placement };
    if (loserSocket.data.account && accounts[loserSocket.data.account]) {
      Object.assign(winPayload, applyRewards(accounts[loserSocket.data.account], placement, totalKills, p.dmg || 0));
    }
    loserSocket.emit('match-over', winPayload);
    // IMPORTANTE: liberar al socket para que pueda volver a buscar partida
    loserSocket.data.room = null;
    loserSocket.data.inQueue = false;
  }

  // IMPORTANTE: el servidor NO declara ganador. Los bots viven en el cliente, así que
  // la victoria real la decide cada cliente (último vivo entre bots + jugadores reales).
  // De lo contrario, al morir/desconectarse el único rival real, se ganaba "top 1" falso
  // con bots todavía vivos.
  const alive = [...match.players.values()].filter(q => q.alive);
  if (alive.length === 0) match.endedAt = Date.now();
}

setInterval(() => {
  for (const [code, match] of matches) {
    const now = Date.now();
    if (match.players.size === 0 || (match.endedAt && now - match.endedAt > 60000)) {
      matches.delete(code);
      io.socketsLeave(code);
      continue;
    }
    const aliveList = [...match.players.values()].filter(p => p.alive);
    const obj = {};
    for (const p of aliveList) {
      obj[p.id] = { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, angle: p.angle || 0 };
    }
    for (const p of aliveList) {
      const s = io.sockets.sockets.get(p.id);
      if (!s) continue;
      // Enviar la lista SIN el propio socket: si el cliente se incluye a sí mismo,
      // la victoria (último vivo) jamás se dispara y el placement sale inflado (+1).
      const others = {};
      for (const o of aliveList) {
        if (o.id !== p.id) others[o.id] = obj[o.id];
      }
      s.emit('update-room-players', { matchId: code, players: others });
    }
  }
}, 1000);

// ---------- Conexiones ----------
io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.inQueue = false;
  socket.data.name = 'Jugador';
  socket.data.points = 0;
  socket.data.color = '#ffffff';
  socket.data.skin = ''; // id del skin premium (ej. skin_fuego) o '' para normal
  socket.data.account = null; // nombre de la cuenta logueada (si hay)

  // ---------- Sistema de cuentas (cada jugador la suya) ----------
  // Los nombres se normalizan a MAYÚSCULAS: "alexis" y "ALEXIS" son la misma cuenta,
  // así ningún nombre se puede repetir aunque cambien mayúsculas o espacios.
  const normName = (n) => String(n || '').trim().toUpperCase().slice(0, 12);

  // ---- INICIAR SESIÓN con CORREO (verificado con Google) o NOMBRE de soldado ----
  // El identificador puede ser el correo vinculado a la cuenta o el nombre del
  // soldado. La contraseña siempre es la del juego (la que se eligió al crear
  // la cuenta o con el enlace de recuperación / la de configuración).
  socket.on('account-login', async (data = {}) => {
    await ensureAccounts();
    const rawId = String(data.name || '').trim();
    let accountKey = null;
    if (rawId && rawId.includes('@')) {
      // Buscar por correo de Google vinculado (coincidencia sin mayúsculas)
      const email = rawId.toLowerCase();
      for (const [n, a] of Object.entries(accounts)) {
        if (a && a.googleEmail && String(a.googleEmail).toLowerCase() === email) { accountKey = n; break; }
      }
    } else {
      accountKey = normName(rawId) || null;
    }
    const acc = accountKey ? accounts[accountKey] : null;
    if (!acc) return socket.emit('account-result', { ok: false, error: 'not-found' });
    // Invitado SIN contraseña: solo puede volver a entrar con el token del mismo
    // dispositivo (evento guest-login); no hay contraseña que verificar aquí.
    if (!acc.password) return socket.emit('account-result', { ok: false, error: 'needs-device' });
    const stored = String(acc.password || '');
    // Contraseñas nuevas: hash bcrypt con sal. Las viejas (hash SHA-256 sin sal,
    // de la era inicial del juego) todavía se validan y se MIGRAN a bcrypt en
    // el primer login de cada jugador.
    let ok = false;
    if (stored.startsWith('$2')) {
      try { ok = await bcrypt.compare(String(data.password || ''), stored); } catch (e) { ok = false; }
    } else {
      ok = stored === sha(data.password);
      if (ok) {
        try { acc.password = await bcrypt.hash(String(data.password || ''), 10); saveAccounts(); } catch (e) { /* se ignora */ }
      }
    }
    if (!ok) return socket.emit('account-result', { ok: false, error: 'bad-pass' });
    // Sesión única: si la cuenta ya está abierta en otra pestaña, se rechaza.
    const prevLock = accountLocks.get(accountKey);
    if (prevLock && prevLock !== socket && prevLock.connected) {
      return socket.emit('account-result', { ok: false, error: 'acct-already-open' });
    }
    accountLocks.set(accountKey, socket);
    acc.lastSeen = Date.now();
    saveAccounts();
    socket.data.account = accountKey;
    socket.data.name = accountKey;
    socket.data.points = acc.points;
    socket.emit('account-result', { ok: true, google: !!acc.googleId, hasPassword: !!(acc.password && !String(acc.password).includes('\\google')), account: { id: acc.id, name: accountKey, googleEmail: acc.googleEmail || '', points: acc.points, level: acc.level, exp: acc.exp, matches: acc.matches || 0, wins: acc.wins || 0, kills: acc.kills || 0, dmg: acc.dmg || 0, deaths: acc.deaths || 0, owns: normalizeAcc(acc).owns || [], gems: normalizeAcc(acc).gems || 0 } });
  });

  socket.on('account-register', async (data = {}) => {
    await ensureAccounts();
    const name = normName(data.name);
    if (name.length < 2) return socket.emit('account-result', { ok: false, error: 'short-name' });
    if (accounts[name]) return socket.emit('account-result', { ok: false, error: 'name-taken' });
    if (String(data.password || '').length < 4) return socket.emit('account-result', { ok: false, error: 'short-pass' });
    let passHash;
    try { passHash = await bcrypt.hash(String(data.password || ''), 10); } catch (e) { passHash = sha(data.password); }
    accounts[name] = { id: genAccountId(), password: passHash, points: 0, level: 1, exp: 0, lastSeen: Date.now(), matches: 0, wins: 0, kills: 0, dmg: 0, deaths: 0, owns: [], gems: 0 };
    saveAccounts();
    accountLocks.set(name, socket);
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = 0;
socket.emit('account-result', { ok: true, account: { id: accounts[name].id, name, points: 0, level: 1, exp: 0, matches: 0, wins: 0, kills: 0, dmg: 0, deaths: 0, owns: [], gems: 0 } });
    });

  // ---- CREAR CUENTA / ENTRAR con Google Sign-In ----
  // Las cuentas se crean SI O SI con Google: el correo queda verificado por la
  // ventana de Google y es el destino de los enlaces de recuperación.
  // Flujo de creación (primera vez): google-login crea la cuenta SIN nombre y
  // con "unnamed" -> el cliente pide la contraseña del juego (google-set-password)
  // -> luego el nombre definitivo (account-set-name). Si se volvía a abrir el
  // juego a mitad del proceso, el siguiente google-login retoma donde quedó.
  socket.on('google-login', async (data = {}) => {
    const token = String(data.token || '');
    if (!token || !googleClient) return socket.emit('account-result', { ok: false, error: 'google-unavailable' });
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (e) {
      return socket.emit('account-result', { ok: false, error: 'google-invalid' });
    }
    await ensureAccounts();
    const sub = String(payload.sub || '');
    if (!sub) return socket.emit('account-result', { ok: false, error: 'google-invalid' });
    let name = findAccountByGoogle(sub);
    let isNew = false;
    if (!name) {
      // Si el correo ya pertenece a otra cuenta, no se puede usar para crear una nueva.
      const email = String(payload.email || '').toLowerCase();
      if (email) {
        for (const [n, a] of Object.entries(accounts)) {
          if (a && a.googleEmail && String(a.googleEmail).toLowerCase() === email) {
            return socket.emit('account-result', { ok: false, error: 'email-taken' });
          }
        }
      }
      // Nombre provisional interno mientras el jugador elige su nombre definitivo
      // (el nombre de la cuenta aún no se muestra en ranking ni en partidas).
      let base = 'J' + sub.slice(0, 7).toUpperCase();
      for (let i = 0; i < 100 && accounts[base]; i++) base = 'J' + sub.slice(0, 6).toUpperCase() + i;
      accounts[base] = { id: genAccountId(), googleId: sub, googleEmail: email, password: sha(crypto.randomBytes(16).toString('hex')) + '\\google', unnamed: true, points: 0, level: 1, exp: 0, lastSeen: Date.now(), matches: 0, wins: 0, kills: 0, dmg: 0, deaths: 0, owns: [], gems: 0 };
      name = base;
      isNew = true;
      saveAccounts();
    }
    const acc = accounts[name];
    // Sesión única: la misma cuenta de Google no puede abrirse dos veces a la vez.
    const prevLock = accountLocks.get(name);
    if (prevLock && prevLock !== socket && prevLock.connected) {
      return socket.emit('account-result', { ok: false, error: 'acct-already-open' });
    }
    accountLocks.set(name, socket);
    acc.lastSeen = Date.now();
    if (acc.unnamed) {
      // Cuenta creada pero aún sin terminar: seguimos con contraseña + nombre.
      socket.data.account = name;
      socket.data.name = name;
      socket.data.points = 0;
      saveAccounts();
      return socket.emit('account-result', { ok: true, google: true, needsName: true, firstTime: isNew, account: { id: acc.id, googleEmail: acc.googleEmail || '' , owns: normalizeAcc(acc).owns || [], gems: normalizeAcc(acc).gems || 0 } });
    }
    saveAccounts();
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = acc.points;
    socket.emit('account-result', { ok: true, google: true, firstTime: isNew, hasPassword: !!(acc.password && !String(acc.password).includes('\\google')), account: { id: acc.id, name, googleEmail: acc.googleEmail || '', points: acc.points, level: acc.level, exp: acc.exp, matches: acc.matches || 0, wins: acc.wins || 0, kills: acc.kills || 0, dmg: acc.dmg || 0, deaths: acc.deaths || 0, owns: normalizeAcc(acc).owns || [], gems: normalizeAcc(acc).gems || 0 } });
  });

  // Poner la CONTRASEÑA DEL JUEGO a una cuenta de Google recién creada
  // (verificada por la ventana de Google). Sin contraseña no se puede iniciar
  // sesión con nombre/correo; con ella también se puede usar la recuperación.
  socket.on('google-set-password', async (data = {}) => {
    if (!socket.data.account) return socket.emit('account-result', { ok: false, error: 'not-found' });
    await ensureAccounts();
    const acc = accounts[socket.data.account];
    if (!acc || !acc.googleId) return socket.emit('account-result', { ok: false, error: 'not-renamable' });
    const p = String(data.password || '');
    if (p.length < 4) return socket.emit('account-result', { ok: false, error: 'short-pass' });
    try { acc.password = await bcrypt.hash(p, 10); } catch (e) { acc.password = sha(p); }
    saveAccounts();
    if (acc.unnamed) return socket.emit('account-result', { ok: true, google: true, needsName: true, account: { id: acc.id, googleEmail: acc.googleEmail || '' , owns: normalizeAcc(acc).owns || [], gems: normalizeAcc(acc).gems || 0 } });
    socket.emit('account-result', { ok: true, google: true, hasPassword: true, account: { id: acc.id, name: socket.data.account, googleEmail: acc.googleEmail || '' , owns: normalizeAcc(acc).owns || [], gems: normalizeAcc(acc).gems || 0 } });
  });

  // ---- JUGAR COMO INVITADO: cuenta sin correo ni Google ----
  // El invitado elige nombre (+ contraseña OPCIONAL). Sin contraseña solo puede
  // volver a entrar desde el MISMO dispositivo (token guardado localmente); con
  // contraseña entra desde cualquier dispositivo recordando nombre + contraseña.
  // Para RECUPERAR una contraseña olvidada NO hay método: debe primero vincular
  // su cuenta a un correo (google-link), y entonces sí llega el enlace.
  socket.on('guest-register', async (data = {}) => {
    await ensureAccounts();
    const name = normName(data.name);
    if (name.length < 2) return socket.emit('account-result', { ok: false, error: 'short-name' });
    if (accounts[name]) return socket.emit('account-result', { ok: false, error: 'name-taken' });
    const p = String(data.password || '');
    let passHash = '';
    if (p) { try { passHash = await bcrypt.hash(p, 10); } catch (e) { passHash = sha(p); } }
    const tok = String(data.deviceToken || '').slice(0, 64);
    accounts[name] = { id: genAccountId(), password: passHash, deviceToken: tok ? sha('dlv:' + tok) : '', points: 0, level: 1, exp: 0, lastSeen: Date.now(), matches: 0, wins: 0, kills: 0, dmg: 0, deaths: 0, owns: [], gems: 0 };
    saveAccounts();
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = 0;
    socket.emit('account-result', { ok: true, guest: true, hasPassword: !!passHash, account: { id: accounts[name].id, name, points: 0, level: 1, exp: 0, matches: 0, wins: 0, kills: 0, dmg: 0, deaths: 0, owns: [], gems: 0 } });
  });

  // Reentrada del invitado SIN contraseña: exige el token del mismo dispositivo.
  socket.on('guest-login', async (data = {}) => {
    await ensureAccounts();
    const name = normName(data.name);
    const acc = name ? accounts[name] : null;
    if (!acc) return socket.emit('account-result', { ok: false, error: 'not-found' });
    if (acc.password) return socket.emit('account-result', { ok: false, error: 'has-password' });
    const tok = String(data.deviceToken || '').slice(0, 64);
    if (!acc.deviceToken || !tok || acc.deviceToken !== sha('dlv:' + tok)) return socket.emit('account-result', { ok: false, error: 'device-only' });
    acc.lastSeen = Date.now();
    saveAccounts();
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = acc.points;
    socket.emit('account-result', { ok: true, guest: true, hasPassword: false, account: { id: acc.id, name, points: acc.points, level: acc.level, exp: acc.exp, matches: acc.matches || 0, wins: acc.wins || 0, kills: acc.kills || 0, dmg: acc.dmg || 0, deaths: acc.deaths || 0, owns: normalizeAcc(acc).owns || [], gems: normalizeAcc(acc).gems || 0 } });
  });

  // Poner/cambiar la CONTRASEÑA DEL JUEGO desde Configuración. Si la cuenta ya
  // tiene contraseña se pide la actual; los invitados sin contraseña la ponen
  // directamente. (Google-created sin contraseña usan google-set-password.)
  socket.on('account-set-password', async (data = {}) => {
    if (!socket.data.account) return socket.emit('account-password-set', { ok: false, error: 'not-found' });
    await ensureAccounts();
    const acc = accounts[socket.data.account];
    if (!acc) return socket.emit('account-password-set', { ok: false, error: 'not-found' });
    const stored = String(acc.password || '');
    const hasReal = !!stored && !String(stored).includes('\\google');
    if (hasReal) {
      let ok = false;
      if (stored.startsWith('$2')) {
        try { ok = await bcrypt.compare(String(data.currentPassword || ''), stored); } catch (e) { ok = false; }
      } else {
        ok = stored === sha(data.currentPassword);
      }
      if (!ok) return socket.emit('account-password-set', { ok: false, error: 'bad-pass' });
    }
    const p = String(data.newPassword || '');
    if (p.length < 4) return socket.emit('account-password-set', { ok: false, error: 'short-pass' });
    try { acc.password = await bcrypt.hash(p, 10); } catch (e) { acc.password = sha(p); }
    saveAccounts();
    socket.emit('account-password-set', { ok: true });
  });

  // VINCULAR la cuenta actual (creada con nombre+contraseña) a Google. Así el
  // soldado puede entrar también con Google y, si se le olvida la contraseña,
  // recibir un enlace de recuperación en su correo de Google.
  socket.on('google-link', async (data = {}) => {
    if (!socket.data.account) return socket.emit('google-linked', { ok: false, error: 'not-found' });
    await ensureAccounts();
    const acc = accounts[socket.data.account];
    if (!acc) return socket.emit('google-linked', { ok: false, error: 'not-found' });
    if (acc.googleId) return socket.emit('google-linked', { ok: false, error: 'already-linked' });
    const token = String(data.token || '');
    if (!token || !googleClient) return socket.emit('google-linked', { ok: false, error: 'google-unavailable' });
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (e) {
      return socket.emit('google-linked', { ok: false, error: 'google-invalid' });
    }
    const sub = String(payload.sub || '');
    if (!sub) return socket.emit('google-linked', { ok: false, error: 'google-invalid' });
    const owner = findAccountByGoogle(sub);
    if (owner && owner !== socket.data.account) return socket.emit('google-linked', { ok: false, error: 'google-in-use' });
    acc.googleId = sub;
    acc.googleEmail = String(payload.email || acc.googleEmail || '');
    acc.lastSeen = Date.now();
    saveAccounts();
    socket.emit('google-linked', { ok: true, account: { name: socket.data.account, googleEmail: acc.googleEmail } });
  });

  // PEDIR recuperación: el jugador dijo "olvidé mi contraseña". El identificador
  // puede ser el CORREO vinculado o el NOMBRE de soldado. Se genera un enlace
  // firmado y se envía al correo de Google vinculado (si SMTP está configurado);
  // en local el enlace se devuelve en la respuesta para probar.
  // Los invitados SIN correo no tienen recuperación: para eso está el vinculo.
  socket.on('request-password-reset', async (data = {}) => {
    try {
      await ensureAccounts();
      const rawId = String(data.name || '').trim();
      let accountKey = null;
      if (rawId && rawId.includes('@')) {
        for (const [n, a] of Object.entries(accounts)) {
          if (a && a.googleEmail && String(a.googleEmail).toLowerCase() === rawId.toLowerCase()) { accountKey = n; break; }
        }
      } else {
        accountKey = normName(rawId) || null;
      }
      const acc = accountKey ? accounts[accountKey] : null;
      if (!acc) return socket.emit('password-reset-requested', { ok: false, error: 'not-found' });
      if (!acc.googleId) return socket.emit('password-reset-requested', { ok: false, error: 'no-email' });
      const token = resetToken(acc.googleId, 'pwreset');
      const resetUrl = APP_BASE_URL + '/?reset=' + encodeURIComponent(token);
      const resetHtml = `<h2>Restablecer contraseña</h2><p>Soldado <b>${accountKey}</b>: abre este enlace para elegir una contraseña nueva:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>El enlace expira en <b>${RESET_TTL_MIN} minutos</b>. Si no lo pediste, ignora este correo.</p>`;
      let emailed = false, emailStatus = 'off', emailError = '';
      if (!acc.googleEmail) {
        // Hay SMTP, pero esta cuenta no tiene correo vinculado: el jugador
        // debe entrar con Google para vincularlo (mensaje claro, no "modo local").
        emailStatus = 'no-target';
      } else if (apiMailProvider()) {
        try {
          await sendMailViaApi(acc.googleEmail, 'FAMOFIRE - Restablecer contraseña', resetHtml);
          emailed = true;
          emailStatus = 'sent';
        } catch (e) {
          emailStatus = 'failed';
          emailError = String((e && e.message) || e || '').replace(/</g, '&lt;').slice(0, 200);
          console.error('[EMAIL] no se pudo enviar (API):', e.message);
        }
      } else if (!transporter) {
        emailStatus = 'off';
      } else {
        try {
          await transporter.sendMail({
            from: MAIL_FROM,
            to: acc.googleEmail,
            subject: 'FAMOFIRE - Restablecer contraseña',
            html: resetHtml
          });
          emailed = true;
          emailStatus = 'sent';
        } catch (e) {
          emailStatus = 'failed';
          emailError = String((e && e.message) || e || '').replace(/</g, '&lt;').slice(0, 200);
          console.error('[EMAIL] no se pudo enviar:', e.message);
        }
      }
      socket.emit('password-reset-requested', { ok: true, emailed, emailStatus, emailError, resetUrl });
    } catch (e) {
      // Nunca dejar al jugador con "..." colgado: ante cualquier error se
      // responde igual para que la pantalla muestre el fallo.
      console.error('[RESET] error inesperado:', e.message);
      socket.emit('password-reset-requested', { ok: false, error: 'server-error' });
    }
  });

  // APLICAR la nueva contraseña con el enlace válido (firmado con la cuenta de Google).
  socket.on('password-reset', async (data = {}) => {
    try {
      const parsed = parseResetToken(data.token);
      if (!parsed || parsed.purpose !== 'pwreset') return socket.emit('password-reset-result', { ok: false, error: 'invalid-token' });
      if (parsed.expired) return socket.emit('password-reset-result', { ok: false, error: 'expired' });
      await ensureAccounts();
      let name = findAccountByGoogle(parsed.googleId);
      if (!name) return socket.emit('password-reset-result', { ok: false, error: 'invalid-token' });
      const newPass = String(data.newPassword || '');
      if (newPass.length < 4) return socket.emit('password-reset-result', { ok: false, error: 'short-pass' });
      try { accounts[name].password = await bcrypt.hash(newPass, 10); } catch (e) { accounts[name].password = sha(newPass); }
      accounts[name].lastSeen = Date.now();
      saveAccounts();
      socket.emit('password-reset-result', { ok: true });
    } catch (e) {
      console.error('[RESET] error inesperado al aplicar:', e.message);
      socket.emit('password-reset-result', { ok: false, error: 'server-error' });
    }
  });

  // Renombrado ÚNICO: solo la primera vez y solo para cuentas creadas con Google
  // que aún no eligieron nombre (unnamed). Después, no hay forma de cambiarlo.
  socket.on('account-set-name', async (data = {}) => {
    if (!socket.data.account) return socket.emit('account-result', { ok: false, error: 'not-found' });
    await ensureAccounts();
    const acc = accounts[socket.data.account];
    if (!acc || !acc.googleId || !acc.unnamed) return socket.emit('account-result', { ok: false, error: 'not-renamable' });
    const name = normName(data.name);
    if (name.length < 2) return socket.emit('account-result', { ok: false, error: 'short-name' });
    if (name !== socket.data.account && accounts[name]) return socket.emit('account-result', { ok: false, error: 'name-taken' });
    if (name !== socket.data.account) {
      accounts[name] = acc;
      delete accounts[socket.data.account];
      saveAccounts();
    }
    acc.unnamed = false;
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = acc.points;
    saveAccounts();
    socket.emit('account-result', { ok: true, google: true, hasPassword: !!(acc.password && !String(acc.password).includes('\\google')), account: { id: acc.id, name, googleEmail: acc.googleEmail || '', points: acc.points, level: acc.level, exp: acc.exp, matches: acc.matches || 0, wins: acc.wins || 0, kills: acc.kills || 0, dmg: acc.dmg || 0, deaths: acc.deaths || 0, gems: acc.gems || 0 } });
  });

  // ---- CAMBIO DE NOMBRE de soldado (cuesta 20 FamoCoins) ----
// Cualquier cuenta logueada puede elegir un nombre nuevo pagando 20 🪙. El ID,
// las monedas, la tienda y el progreso se conservan: solo cambia la CLAVE de la
// cuenta (su nombre). Los nombres no permitidos: mismo nombre, nombre en uso,
// menos de 2 caracteres o sin saldo suficiente.
const RENAME_COST = 20;
socket.on('account-rename', async (data = {}) => {
    if (!socket.data.account) return socket.emit('account-renamed', { ok: false, error: 'not-found' });
    await ensureAccounts();
    const oldName = socket.data.account;
    const acc = accounts[oldName];
    if (!acc) return socket.emit('account-renamed', { ok: false, error: 'not-found' });
    const name = normName(data.name);
    if (name.length < 2) return socket.emit('account-renamed', { ok: false, error: 'short-name' });
    if (name === oldName) return socket.emit('account-renamed', { ok: false, error: 'same-name' });
    if (accounts[name]) return socket.emit('account-renamed', { ok: false, error: 'name-taken' });
    if ((Number(acc.gems) || 0) < RENAME_COST) return socket.emit('account-renamed', { ok: false, error: 'no-coins' });
    acc.gems = (Number(acc.gems) || 0) - RENAME_COST;
    accounts[name] = acc;
    delete accounts[oldName];
    // Mover el candado de sesión única y el estado del socket al nombre nuevo.
    const lock = accountLocks.get(oldName);
    if (lock) { accountLocks.delete(oldName); accountLocks.set(name, lock); }
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = acc.points;
    // La BD indexa por nombre (clave primaria): se borra la fila vieja y el
    // siguiente saveAccounts() crea/actualiza la fila con el nombre nuevo.
    if (db) { try { await db.query('DELETE FROM accounts WHERE name = $1', [oldName]); } catch (e) { console.error('[RENAME] no se pudo borrar la fila vieja:', e.message); } }
    saveAccounts();
    socket.emit('account-renamed', { ok: true, name, gems: acc.gems, id: acc.id });
  });

  socket.on('account-update', (data = {}) => {
    if (!socket.data.account) return;
    const acc = accounts[socket.data.account];
    if (!acc) return;
    acc.points = clamp(Math.floor(num(data.points, acc.points)), 0, 999999);
    acc.level = clamp(Math.floor(num(data.level, acc.level)), 1, 100);
    acc.exp = clamp(Math.floor(num(data.exp, acc.exp)), 0, 999999);
    acc.lastSeen = Date.now();
    socket.data.points = acc.points;
    saveAccounts();
  });

  // Estadísticas históricas por cuenta: partidas, victorias, bajas y daño total.
  // El cliente reporta al terminar cada partida; el rate-limit evita inflarlas a mano.
  socket.on('match-results', (data = {}) => {
    if (!socket.data.account) return;
    if (socket.data.lastStatsAt && Date.now() - socket.data.lastStatsAt < 5000) return;
    socket.data.lastStatsAt = Date.now();
    const acc = accounts[socket.data.account];
    if (!acc) return;
    acc.matches = (Number(acc.matches) || 0) + 1;
    if (data.win) acc.wins = (Number(acc.wins) || 0) + 1;
    acc.kills = (Number(acc.kills) || 0) + Math.max(0, Math.floor(num(data.kills, 0)));
    acc.dmg = (Number(acc.dmg) || 0) + Math.max(0, Math.floor(num(data.dmg, 0)));
    acc.deaths = (Number(acc.deaths) || 0) + Math.max(0, Math.floor(num(data.deaths, 0)));
    acc.lastSeen = Date.now();
    saveAccounts();
  });

  socket.on('player-join', (data = {}) => {
    socket.data.name = normName(data.name || socket.data.name);
    socket.data.color = data.color || '#ffffff';
    socket.data.skin = String(data.skin || '');
    if (socket.data.account) {
      socket.data.points = accounts[socket.data.account] ? accounts[socket.data.account].points : 0;
    } else {
      socket.data.points = Math.max(0, Math.floor(num(data.points, 0)));
    }
  });

  socket.on('get-top100', () => {
    socket.emit('update-top100', getTop100());
  });

  // ---------- CORREO del juego (estilo Free Fire) ----------
  // Cada cuenta tiene su buzón (mails[]). Enviar un regalo saca el artículo de
  // tu inventario YA y crea un sobre en el buzón del destinatario; al reclamarlo,
  // el artículo entra a SU inventario.
  function emitMails() {
    socket.emit('update-mails', { mails: (socket.data.account ? (accounts[socket.data.account] ? accounts[socket.data.account].mails || [] : []) : []).slice().sort((x, y) => (y.sentAt || 0) - (x.sentAt || 0)) });
  }
  socket.on('get-mails', async () => {
    await ensureAccounts();
    if (!socket.data.account || !accounts[socket.data.account]) return socket.emit('mail-result', { ok: false, error: 'not-found' });
    emitMails();
  });
  // Enviar un artículo (por nombre o ID del soldado destino) como regalo.
  socket.on('send-mail', async (data = {}) => {
    await ensureAccounts();
    if (!socket.data.account || !accounts[socket.data.account]) return socket.emit('mail-result', { ok: false, error: 'not-found' });
    const itemId = String(data.itemId || '');
    const item = PREMIUM_ITEMS[itemId];
    if (!item) return socket.emit('mail-result', { ok: false, error: 'bad-item' });
    const fromAcc = accounts[socket.data.account];
    if (!(fromAcc.owns || []).includes(itemId)) return socket.emit('mail-result', { ok: false, error: 'no-own' });
    const rawTo = String(data.to || '').trim();
    let toName = null;
    if (rawTo.includes('@')) {
      const email = rawTo.toLowerCase();
      for (const [n, a] of Object.entries(accounts)) {
        if (a && a.googleEmail && String(a.googleEmail).toLowerCase() === email) { toName = n; break; }
      }
    } else {
      toName = normName(rawTo) || null;
      if (!toName) toName = findAccountById(rawTo);
    }
    const toAcc = toName ? accounts[toName] : null;
    if (!toAcc) return socket.emit('mail-result', { ok: false, error: 'no-to' });
    if (toName === socket.data.account) return socket.emit('mail-result', { ok: false, error: 'self' });
    // El artículo sale de tu inventario en el momento del envío.
    fromAcc.owns = fromAcc.owns.filter(x => x !== itemId);
    toAcc.mails = toAcc.mails || [];
    toAcc.mails.push({
      id: genId(), from: socket.data.account, to: toName, itemId,
      msg: String(data.msg || '').slice(0, 1000),
      sentAt: Date.now(), claimed: false
    });
    saveAccounts();
    socket.emit('mail-result', { ok: true, itemId, sent: true });
    emitMails();
  });
  // Reclamar un regalo: el artículo entra a tu inventario.
  socket.on('claim-mail', async (data = {}) => {
    await ensureAccounts();
    if (!socket.data.account || !accounts[socket.data.account]) return socket.emit('mail-result', { ok: false, error: 'not-found' });
    const acc = accounts[socket.data.account];
    const mail = (acc.mails || []).find(m => m.id === String(data.mailId || ''));
    if (!mail || mail.to !== socket.data.account) return socket.emit('mail-result', { ok: false, error: 'bad-mail' });
    // Un comunicado (sin artículo) ya viene marcado como recibido.
    if (!mail.itemId) return socket.emit('mail-result', { ok: false, error: 'already' });
    if (mail.claimed) return socket.emit('mail-result', { ok: false, error: 'already' });
    if (!(acc.owns || []).includes(mail.itemId)) {
      acc.owns = acc.owns || [];
      acc.owns.push(mail.itemId);
    }
    mail.claimed = true;
    saveAccounts();
    socket.emit('mail-result', { ok: true, itemId: mail.itemId, claimed: true });
    emitMails();
  });

  // Eliminar cuenta definitivamente: pide la contraseña (menos las cuentas de
  // Google, que no tienen contraseña y se borran desde el dispositivo con la
  // sesión iniciada). La cuenta se quita de la cola si está esperando partida
  // y se borra también de PostgreSQL (no solo del mapa en memoria).
  socket.on('account-delete', async (data = {}) => {
    if (!socket.data.account) return socket.emit('account-deleted', { ok: false, error: 'not-found' });
    if (socket.data.room) return socket.emit('account-deleted', { ok: false, error: 'in-match' });
    await ensureAccounts();
    const name = socket.data.account;
    const acc = accounts[name];
    if (!acc) return socket.emit('account-deleted', { ok: false, error: 'not-found' });
    let ok = true;
    if (!acc.googleId && acc.password) {
      const stored = String(acc.password || '');
      if (stored.startsWith('$2')) {
        try { ok = await bcrypt.compare(String(data.password || ''), stored); } catch (e) { ok = false; }
      } else {
        ok = stored === sha(data.password);
      }
    }
    if (!ok) return socket.emit('account-deleted', { ok: false, error: 'bad-pass' });
    const qi = queue.findIndex(q => q.socket.id === socket.id);
    if (qi >= 0) { queue.splice(qi, 1); socket.data.inQueue = false; }
    if (queue.length === 0 && queueTimer) { clearTimeout(queueTimer); queueTimer = null; queueDeadline = 0; queueStartAt = 0; }
    delete accounts[name];
    socket.data.account = null;
    if (db) { try { await db.query('DELETE FROM accounts WHERE name = $1', [name]); } catch (e) { console.error('[DB] error borrando cuenta:', e.message); } }
    saveAccounts();
    socket.emit('account-deleted', { ok: true });
    broadcastQueueStatus();
  });

  socket.on('join-matchmaking', (data = {}) => {
    if (socket.data.inQueue || socket.data.room) return;
    socket.data.name = normName(data.name || socket.data.name);
    socket.data.points = Math.max(0, Math.floor(num(data.points, socket.data.points)));
    socket.data.color = data.color || socket.data.color;
    socket.data.skin = String(data.skin || socket.data.skin || '');
    socket.data.inQueue = true;
    queue.push({ socket, name: socket.data.name, points: socket.data.points, color: socket.data.color, skin: socket.data.skin });
    socket.emit('mm-status', { inQueue: true, count: queue.length, remaining: Math.max(0, (queueDeadline || Date.now() + QUEUE_TIMEOUT) - Date.now()) });
    if (queue.length >= MATCH_SIZE) {
      startMatch();
    } else if (!queueTimer) {
      queueStartAt = Date.now();
      queueDeadline = Date.now() + QUEUE_TIMEOUT;
      queueTimer = setTimeout(maybeStartMatch, QUEUE_TIMEOUT);
      broadcastQueueStatus();
    } else {
      // El contador compartido NO se reinicia cuando entra otro jugador real:
      // la partida sale a la hora ya anunciada y todos los de la cola entran juntos.
      broadcastQueueStatus();
    }
  });

  socket.on('cancel-matchmaking', () => {
    const i = queue.findIndex(q => q.socket.id === socket.id);
    if (i >= 0) queue.splice(i, 1);
    socket.data.inQueue = false;
    if (queue.length === 0 && queueTimer) { clearTimeout(queueTimer); queueTimer = null; queueDeadline = 0; queueStartAt = 0; }
    broadcastQueueStatus();
  });

  socket.on('player-move', (data = {}) => {
    if (!socket.data.room) return;
    const match = matches.get(socket.data.room);
    const p = match && match.players.get(socket.id);
    if (!p || !p.alive) return;
    const x = num(data.x, p.x), y = num(data.y, p.y), angle = num(data.angle, p.angle);
    if (x < -1000 || x > MAP.w + 1000 || y < -1000 || y > MAP.h + 1000) return;
    p.x = x; p.y = y; p.angle = angle;
    const now = Date.now();
    // Fase 1: relé a 100 ms (10 posiciones/s por jugador) en vez de 40 ms:
    // corta ~60% del tráfico de posiciones sin que se note en el juego.
    if (!p.lastRelay || now - p.lastRelay > 100) {
      p.lastRelay = now;
      socket.to(socket.data.room).emit('update-player-position', { matchId: match.code, id: socket.id, x: p.x, y: p.y, angle: p.angle });
    }
  });

  socket.on('player-shot', (data = {}) => {
    if (!socket.data.room) return;
    const match = matches.get(socket.data.room);
    const p = match && match.players.get(socket.id);
    if (!p || !p.alive) return;
    socket.to(socket.data.room).emit('remote-shot', { matchId: match.code, id: socket.id, x: p.x, y: p.y, angle: num(data.angle, p.angle) });
  });

  socket.on('damage', (data = {}) => {
    if (!socket.data.room) return;
    const match = matches.get(socket.data.room);
    const shooter = match && match.players.get(socket.id);
    const victim = match && match.players.get(data.victimId);
    if (!match || !shooter || !shooter.alive || !victim || !victim.alive) return;
    if (victim.id === shooter.id) return;
    // VALIDACIÓN (anti-trampa): el daño entre jugadores reales es AUTORITATIVO.
    // 1) Limitado a la cadencia realista de disparos (máx 12 impactos/segundo).
    const now = Date.now();
    if (shooter.lastHitAt && now - shooter.lastHitAt < 80) return;
    shooter.lastHitAt = now;
    // 2) Alcance máximo de una bala (480 + radios): sin "francotiradores" fuera del mapa.
    const dx = shooter.x - victim.x, dy = shooter.y - victim.y;
    if (dx * dx + dy * dy > 560 * 560) return;
    // 3) El escudo se sincroniza con el servidor (misma ventana que el cliente).
    if (victim.shieldUntil && victim.shieldUntil > now) return;
    // 4) La vida la lleva el SERVIDOR: el victimario no puede spamear daño infinito.
    victim.hp -= 25;
    shooter.dmg += 25;
    const vSocket = io.sockets.sockets.get(victim.id);
    if (!vSocket) return;
    vSocket.emit('receive-damage', { matchId: match.code, dmg: 25, killerId: shooter.id, killerName: shooter.name });
    if (victim.hp <= 0) {
      // MUERTE DECLARADA POR EL SERVIDOR: se le pide al cliente la posición exacta
      // (él cuenta los bots, que son locales) y se cierra la partida con 3 s de
      // gracia por si el cliente no responde (se cierra igual, sin recompensa extra).
      vSocket.emit('you-died', { matchId: match.code, killerId: shooter.id, killerName: shooter.name });
      if (!victim.deathTimer) {
        victim.deathTimer = setTimeout(() => {
          if (match.players.has(victim.id) && match.players.get(victim.id).alive) endMatchFor(match, victim.id, null, 0);
        }, 3000);
      }
    }
  });

  // Sincronización del escudo con el servidor: mientras esté activo, el daño real
  // no descuenta vida (igual que en el cliente: el escudo absorbe todo).
  // Victoria declarada por el cliente (último vivo entre bots locales): el servidor
  // la sanciona SOLO si ningún otro jugador real sigue vivo y entrega las
  // recompensas oficiales (placement 1). Sin esto un tramposo ganaría puntos gratis.
  socket.on('match-won', (data = {}) => {
    if (!socket.data.room) return;
    const match = matches.get(socket.data.room);
    const p = match && match.players.get(socket.id);
    if (!match || !p || !p.alive || p.wonClaimed) return;
    const othersAlive = [...match.players.values()].filter(q => q.alive && q.id !== p.id);
    if (othersAlive.length > 0) return;
    p.wonClaimed = true;
    const botKills = Math.max(0, Math.floor(num(data.kills, 0)));
    const totalKills = Math.min((p.kills || 0) + botKills, (p.kills || 0) + 40);
    const winPayload = { matchId: match.code, placement: 1 };
    if (socket.data.account && accounts[socket.data.account]) {
      Object.assign(winPayload, applyRewards(accounts[socket.data.account], 1, totalKills, p.dmg || 0));
    }
    socket.emit('match-over', winPayload);
  });

  socket.on('skill-state', (data = {}) => {
    if (!socket.data.room) return;
    const match = matches.get(socket.data.room);
    const p = match && match.players.get(socket.id);
    if (!match || !p) return;
    if (data.skill === 'shield' && data.active) {
      p.shieldUntil = Date.now() + Math.min(5000, Math.max(0, Math.floor(num(data.duration, 5000))));
    }
  });

  socket.on('player-died', (data = {}) => {
    if (!socket.data.room) return;
    const match = matches.get(socket.data.room);
    const p = match && match.players.get(socket.id);
    if (!match || !p || !p.alive) return;
    p.deadAck = true;
    // Cada baja = una muerte para la cuenta del derrotado (para el KD del perfil).
    const loserAcc = accounts[socket.data.account];
    if (loserAcc) { loserAcc.deaths = (Number(loserAcc.deaths) || 0) + 1; loserAcc.lastSeen = Date.now(); saveAccounts(); }
    const killer = match.players.get(data.killerId);
    p.killedBy = killer ? killer.name : null;
    if (killer && killer.alive) {
      killer.kills += 1;
      const kSocket = io.sockets.sockets.get(killer.id);
      if (kSocket) kSocket.emit('kill-confirm', { matchId: match.code, victim: p.name });
    }
    endMatchFor(match, socket.id, data.placement, data.kills);
  });

  // Salida voluntaria de la partida (ganaste, la cerraste, etc.): libera el socket
  // para que pueda volver a buscar partida sin recargar la página.
  socket.on('leave-match', () => {
    const code = socket.data.room;
    if (code && matches.has(code)) {
      const match = matches.get(code);
      if (match.players.has(socket.id)) {
        match.players.delete(socket.id);
        io.to(code).emit('remove-player', { matchId: code, id: socket.id });
        match.aliveCount = [...match.players.values()].filter(q => q.alive).length;
        io.to(code).emit('update-room-alive', match.aliveCount);
        if (match.players.size === 0) match.endedAt = Date.now();
      }
    }
    socket.data.room = null;
    socket.data.inQueue = false;
  });

  // Cierre de sesión explícito: se libera el candado de la cuenta AL INSTANTE,
  // sin esperar el timeout de conexión (~10 s), así otra pestaña/dispositivo
  // puede entrar con esa cuenta de inmediato después de cerrar sesión.
  socket.on('logout', () => {
    if (socket.data.account && accountLocks.get(socket.data.account) === socket) {
      accountLocks.delete(socket.data.account);
    }
    socket.data.account = null;
    socket.data.name = null;
  });

  socket.on('disconnect', () => {
    // Liberar el candado de sesión única si esta pestaña era la dueña de la cuenta.
    if (socket.data.account && accountLocks.get(socket.data.account) === socket) {
      accountLocks.delete(socket.data.account);
    }
    const i = queue.findIndex(q => q.socket.id === socket.id);
    if (i >= 0) {
      queue.splice(i, 1);
      socket.data.inQueue = false;
      if (queue.length === 0 && queueTimer) { clearTimeout(queueTimer); queueTimer = null; queueDeadline = 0; queueStartAt = 0; }
      broadcastQueueStatus();
    }
    const code = socket.data.room;
    if (code && matches.has(code)) {
      const match = matches.get(code);
      match.players.delete(socket.id);
      io.to(code).emit('remove-player', { matchId: code, id: socket.id });
      match.aliveCount = [...match.players.values()].filter(q => q.alive).length;
      io.to(code).emit('update-room-alive', match.aliveCount);
      // Sin victoria automática: la decide cada cliente (los bots son locales)
      if (match.aliveCount === 0) match.endedAt = Date.now();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FAMOFIRE corriendo en http://localhost:${PORT}`);
  console.log('Juega online: usa esta misma IP/puerto desde otros dispositivos o despliega el proyecto en la web.');
  ensureAccounts();
});

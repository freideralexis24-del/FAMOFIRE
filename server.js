// ============================================================
// FAMOFIRE - Servidor central (LATAM)
// Emparejamiento global, salas de batalla, ranking Top 100
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const { Server } = require('socket.io');

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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));
// Config pública para el cliente: script de login con Google (vacío = desactivado).
app.get('/config', (req, res) => res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' }));

// ---------- Cuentas de jugador (cada persona tiene la suya) ----------
// En la web (Render) las cuentas se guardan en PostgreSQL gratuito (variable
// DATABASE_URL) para que NUNCA se borren con las actualizaciones. En local
// (sin DATABASE_URL) se sigue usando accounts.json.
const DATABASE_URL = process.env.DATABASE_URL || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// Verificación de ID tokens de Google Sign-In (solo se crea si está configurado)
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
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
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS matches INT NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS wins INT NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kills INT NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dmg INT NOT NULL DEFAULT 0');
        await db.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deaths INT NOT NULL DEFAULT 0');
      } catch (e) { /* versión vieja de Postgres u otro problema menor: se ignora */ }
      const { rows } = await db.query('SELECT name, password, points, level, exp, lastseen, id, google_id, matches, wins, kills, dmg, deaths FROM accounts');
      accounts = {};
      for (const r of rows) {
        accounts[r.name] = { id: r.id || genId(), password: r.password, points: Number(r.points), level: Number(r.level), exp: Number(r.exp), lastSeen: Number(r.lastseen) || 0, googleId: r.google_id || '', matches: Number(r.matches) || 0, wins: Number(r.wins) || 0, kills: Number(r.kills) || 0, dmg: Number(r.dmg) || 0, deaths: Number(r.deaths) || 0 };
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
  let backfilled = false;
  for (const name of Object.keys(accounts)) {
    const a = accounts[name];
    if (a && !a.id) {
      a.id = genId();
      backfilled = true;
    }
  }
  if (backfilled) saveAccounts();
  accountsReady = true;
}
function genId() {
  // ID corto y legible (8 caracteres hex) para controlar cada cuenta
  return crypto.randomBytes(4).toString('hex').toUpperCase();
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
    const q = `INSERT INTO accounts (name, id, password, points, level, exp, lastseen, google_id, matches, wins, kills, dmg, deaths)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
               ON CONFLICT (name) DO UPDATE SET
                 password = EXCLUDED.password,
                 points = EXCLUDED.points,
                 level = EXCLUDED.level,
                 exp = EXCLUDED.exp,
                 lastseen = EXCLUDED.lastseen,
                 google_id = EXCLUDED.google_id,
                 matches = EXCLUDED.matches,
                 wins = EXCLUDED.wins,
                 kills = EXCLUDED.kills,
                 dmg = EXCLUDED.dmg,
                 deaths = EXCLUDED.deaths`;
    for (const [name, a] of Object.entries(accounts)) {
      await client.query(q, [name, a.id || genId(), a.password, Number(a.points) || 0, Number(a.level) || 1, Number(a.exp) || 0, Number(a.lastSeen) || 0, a.googleId || '', Number(a.matches) || 0, Number(a.wins) || 0, Number(a.kills) || 0, Number(a.dmg) || 0, Number(a.deaths) || 0]);
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
    .map(([name, a]) => ({ name, points: a.points || 0 }))
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

function broadcastOnline() {
  io.emit('update-global-online', io.engine.clientsCount);
}

// ---------- Cola de emparejamiento ----------
const queue = [];
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
      id: q.socket.id, name: q.name, color: q.color, points: q.points,
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
    players: [...players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, x: p.x, y: p.y })),
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
  socket.data.account = null; // nombre de la cuenta logueada (si hay)
  broadcastOnline();

  // ---------- Sistema de cuentas (cada jugador la suya) ----------
  // Los nombres se normalizan a MAYÚSCULAS: "alexis" y "ALEXIS" son la misma cuenta,
  // así ningún nombre se puede repetir aunque cambien mayúsculas o espacios.
  const normName = (n) => String(n || '').trim().toUpperCase().slice(0, 12);

  socket.on('account-login', async (data = {}) => {
    await ensureAccounts();
    const name = normName(data.name);
    const acc = accounts[name];
    if (!acc) return socket.emit('account-result', { ok: false, error: 'not-found' });
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
    acc.lastSeen = Date.now();
    saveAccounts();
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = acc.points;
    socket.emit('account-result', { ok: true, account: { id: acc.id, name, points: acc.points, level: acc.level, exp: acc.exp, matches: acc.matches || 0, wins: acc.wins || 0, kills: acc.kills || 0, dmg: acc.dmg || 0, deaths: acc.deaths || 0 } });
  });

  socket.on('account-register', async (data = {}) => {
    await ensureAccounts();
    const name = normName(data.name);
    if (name.length < 2) return socket.emit('account-result', { ok: false, error: 'short-name' });
    if (accounts[name]) return socket.emit('account-result', { ok: false, error: 'name-taken' });
    if (String(data.password || '').length < 4) return socket.emit('account-result', { ok: false, error: 'short-pass' });
    let passHash;
    try { passHash = await bcrypt.hash(String(data.password || ''), 10); } catch (e) { passHash = sha(data.password); }
    accounts[name] = { id: genId(), password: passHash, points: 0, level: 1, exp: 0, lastSeen: Date.now(), matches: 0, wins: 0, kills: 0, dmg: 0, deaths: 0 };
    saveAccounts();
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = 0;
    socket.emit('account-result', { ok: true, account: { id: accounts[name].id, name, points: 0, level: 1, exp: 0, matches: 0, wins: 0, kills: 0, dmg: 0, deaths: 0 } });
  });

  // ---- Login con Google Sign-In ----
  // El cliente envía el ID token (JWT corto, 1 h de vida); acá se verifica la
  // firma contra el servidor de Google y se vincula/retoma la cuenta por googleId.
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
    let name = null;
    for (const [n, a] of Object.entries(accounts)) {
      if (a && a.googleId === sub) { name = n; break; }
    }
    let isNew = false;
    if (!name) {
      // Cuenta nueva: se usa el nombre de Google (o el correo) como nickname;
      // si está tomado, se agrega un sufijo numérico hasta encontrar uno libre.
      const raw = String(payload.name || payload.email || 'jugador').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      let base = normName(raw) || ('J' + sub.slice(0, 7));
      for (let i = 0; i < 100 && accounts[base]; i++) {
        base = normName(raw) + String(i + 1);
        if (base.length > 12) base = normName(raw).slice(0, 11 - String(i + 1).length) + String(i + 1);
        if (!base) break;
      }
      if (!base || accounts[base]) return socket.emit('account-result', { ok: false, error: 'google-name' });
      // Contraseña inutilizable: solo se entra con Google.
      accounts[base] = { id: genId(), googleId: sub, password: sha(crypto.randomBytes(16).toString('hex')) + '\\google', points: 0, level: 1, exp: 0, lastSeen: Date.now(), matches: 0, wins: 0, kills: 0, dmg: 0, deaths: 0 };
      name = base;
      isNew = true;
      saveAccounts();
    }
    const acc = accounts[name];
    acc.lastSeen = Date.now();
    saveAccounts();
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = acc.points;
    socket.emit('account-result', { ok: true, google: true, firstTime: isNew, account: { id: acc.id, name, points: acc.points, level: acc.level, exp: acc.exp, matches: acc.matches || 0, wins: acc.wins || 0, kills: acc.kills || 0, dmg: acc.dmg || 0, deaths: acc.deaths || 0 } });
  });

  // Renombrado ÚNICO: solo la primera vez y solo para cuentas creadas con Google.
  // Después de confirmar, no existe ninguna forma de cambiar el nombre.
  socket.on('account-set-name', async (data = {}) => {
    if (!socket.data.account) return socket.emit('account-result', { ok: false, error: 'not-found' });
    await ensureAccounts();
    const acc = accounts[socket.data.account];
    if (!acc || !acc.googleId) return socket.emit('account-result', { ok: false, error: 'not-renamable' });
    const name = normName(data.name);
    if (name.length < 2) return socket.emit('account-result', { ok: false, error: 'short-name' });
    if (name !== socket.data.account && accounts[name]) return socket.emit('account-result', { ok: false, error: 'name-taken' });
    if (name !== socket.data.account) {
      accounts[name] = acc;
      delete accounts[socket.data.account];
      saveAccounts();
    }
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = acc.points;
    socket.emit('account-result', { ok: true, account: { id: acc.id, name, points: acc.points, level: acc.level, exp: acc.exp, matches: acc.matches || 0, wins: acc.wins || 0, kills: acc.kills || 0, dmg: acc.dmg || 0, deaths: acc.deaths || 0 } });
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
    if (socket.data.account) {
      socket.data.points = accounts[socket.data.account] ? accounts[socket.data.account].points : 0;
    } else {
      socket.data.points = Math.max(0, Math.floor(num(data.points, 0)));
    }
  });

  socket.on('get-top100', () => {
    socket.emit('update-top100', getTop100());
  });

  socket.on('join-matchmaking', (data = {}) => {
    if (socket.data.inQueue || socket.data.room) return;
    socket.data.name = normName(data.name || socket.data.name);
    socket.data.points = Math.max(0, Math.floor(num(data.points, socket.data.points)));
    socket.data.color = data.color || socket.data.color;
    socket.data.inQueue = true;
    queue.push({ socket, name: socket.data.name, points: socket.data.points, color: socket.data.color });
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

  socket.on('disconnect', () => {
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
    broadcastOnline();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FAMOFIRE corriendo en http://localhost:${PORT}`);
  console.log('Juega online: usa esta misma IP/puerto desde otros dispositivos o despliega el proyecto en la web.');
  ensureAccounts();
});

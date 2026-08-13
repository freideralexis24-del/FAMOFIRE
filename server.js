// ============================================================
// FAMOFIRE - Servidor central (LATAM)
// Emparejamiento global, salas de batalla, ranking Top 100
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MATCH_SIZE = 35;                              // cupos por partida (jugadores reales + bots)
const QUEUE_TIMEOUT = parseInt(process.env.MM_TIMEOUT_MS || '30000', 10); // espera máxima en cola
const MAP = { w: 3600, h: 2000 };                   // mapa fijo del Campo de Batalla (sincronizado)
const SPAWN_MIN_DIST = 400;                         // distancia mínima entre apariciones
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

// ---------- Cuentas de jugador (cada persona tiene la suya) ----------
// En la web (Render) las cuentas se guardan en PostgreSQL gratuito (variable
// DATABASE_URL) para que NUNCA se borren con las actualizaciones. En local
// (sin DATABASE_URL) se sigue usando accounts.json.
const DATABASE_URL = process.env.DATABASE_URL || '';
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
      const { rows } = await db.query('SELECT name, password, points, level, exp FROM accounts');
      accounts = {};
      for (const r of rows) {
        accounts[r.name] = { password: r.password, points: Number(r.points), level: Number(r.level), exp: Number(r.exp) };
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
  }
  // Limpieza de arranque: se descartan cuentas sin ningún progreso (0 puntos, nivel 1,
  // sin experiencia). Son cuentas de prueba o abandonadas al instante: no aparecen en
  // el Top y no ocupan espacio. Las cuentas reales (con al menos 1 punto) se conservan.
  let purged = false;
  for (const name of Object.keys(accounts)) {
    const a = accounts[name];
    if (a && (Number(a.points) || 0) === 0 && (a.level || 1) === 1 && (a.exp || 0) === 0) {
      delete accounts[name];
      purged = true;
    }
  }
  if (purged) saveAccounts();
  accountsReady = true;
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
    const q = `INSERT INTO accounts (name, password, points, level, exp)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (name) DO UPDATE SET
                 password = EXCLUDED.password,
                 points = EXCLUDED.points,
                 level = EXCLUDED.level,
                 exp = EXCLUDED.exp`;
    for (const [name, a] of Object.entries(accounts)) {
      await client.query(q, [name, a.password, Number(a.points) || 0, Number(a.level) || 1, Number(a.exp) || 0]);
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
  const taken = queue.splice(0, MATCH_SIZE);
  if (taken.length === 0) return;

  const roomCode = 'match-' + Date.now() + '-' + Math.floor(Math.random() * 999);
  const spawns = assignSpawns(taken);
  const players = new Map();

  taken.forEach((q, i) => {
    players.set(q.socket.id, {
      id: q.socket.id, name: q.name, color: q.color, points: q.points,
      x: spawns[i].x, y: spawns[i].y, angle: 0, alive: true,
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

// clientPlacement: posición real reportada por el cliente (cuenta los bots, que son locales).
// El servidor solo conoce jugadores reales, así que no puede calcular la posición real por su cuenta.
function endMatchFor(match, loserId, clientPlacement) {
  const p = match.players.get(loserId);
  if (!p || !p.alive) return;
  p.alive = false;
  match.aliveCount = [...match.players.values()].filter(q => q.alive).length;
  io.to(match.code).emit('remove-player', loserId);
  io.to(match.code).emit('update-room-alive', match.aliveCount);

  const order = [...match.players.values()].filter(q => !q.alive).length;
  const fallback = Math.max(1, match.players.size - order + 1);
  const placement = Math.max(1, Math.floor(num(clientPlacement, fallback)));
  io.to(match.code).emit('kill-feed', { killer: p.killedBy || 'Zona', victim: p.name });
  const loserSocket = io.sockets.sockets.get(loserId);
  if (loserSocket) loserSocket.emit('match-over', { placement });

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
      if (s) s.emit('update-room-players', obj);
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
    if (acc.password !== sha(data.password)) return socket.emit('account-result', { ok: false, error: 'bad-pass' });
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = acc.points;
    socket.emit('account-result', { ok: true, account: { name, points: acc.points, level: acc.level, exp: acc.exp } });
  });

  socket.on('account-register', async (data = {}) => {
    await ensureAccounts();
    const name = normName(data.name);
    if (name.length < 2) return socket.emit('account-result', { ok: false, error: 'short-name' });
    if (accounts[name]) return socket.emit('account-result', { ok: false, error: 'name-taken' });
    if (String(data.password || '').length < 4) return socket.emit('account-result', { ok: false, error: 'short-pass' });
    accounts[name] = { password: sha(data.password), points: 0, level: 1, exp: 0 };
    saveAccounts();
    socket.data.account = name;
    socket.data.name = name;
    socket.data.points = 0;
    socket.emit('account-result', { ok: true, account: { name, points: 0, level: 1, exp: 0 } });
  });

  socket.on('account-update', (data = {}) => {
    if (!socket.data.account) return;
    const acc = accounts[socket.data.account];
    if (!acc) return;
    acc.points = clamp(Math.floor(num(data.points, acc.points)), 0, 999999);
    acc.level = clamp(Math.floor(num(data.level, acc.level)), 1, 100);
    acc.exp = clamp(Math.floor(num(data.exp, acc.exp)), 0, 999999);
    socket.data.points = acc.points;
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
    socket.emit('mm-status', { inQueue: true, count: queue.length });
    if (queue.length >= MATCH_SIZE) {
      startMatch();
    } else if (!queueTimer) {
      queueTimer = setTimeout(() => {
        if (queue.length > 0) startMatch();
      }, QUEUE_TIMEOUT);
    }
  });

  socket.on('cancel-matchmaking', () => {
    const i = queue.findIndex(q => q.socket.id === socket.id);
    if (i >= 0) queue.splice(i, 1);
    socket.data.inQueue = false;
    if (queue.length === 0 && queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
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
    if (!p.lastRelay || now - p.lastRelay > 40) {
      p.lastRelay = now;
      socket.to(socket.data.room).emit('update-player-position', { id: socket.id, x: p.x, y: p.y, angle: p.angle });
    }
  });

  socket.on('player-shot', (data = {}) => {
    if (!socket.data.room) return;
    const match = matches.get(socket.data.room);
    const p = match && match.players.get(socket.id);
    if (!p || !p.alive) return;
    socket.to(socket.data.room).emit('remote-shot', { id: socket.id, x: p.x, y: p.y, angle: num(data.angle, p.angle) });
  });

  socket.on('damage', (data = {}) => {
    if (!socket.data.room) return;
    const match = matches.get(socket.data.room);
    const shooter = match && match.players.get(socket.id);
    const victim = match && match.players.get(data.victimId);
    if (!match || !shooter || !shooter.alive || !victim || !victim.alive) return;
    const vSocket = io.sockets.sockets.get(victim.id);
    if (vSocket) {
      vSocket.emit('receive-damage', { dmg: num(data.dmg, 25), killerId: socket.id, killerName: shooter.name });
    }
  });

  socket.on('player-died', (data = {}) => {
    if (!socket.data.room) return;
    const match = matches.get(socket.data.room);
    const p = match && match.players.get(socket.id);
    if (!match || !p || !p.alive) return;
    const killer = match.players.get(data.killerId);
    p.killedBy = killer ? killer.name : null;
    if (killer && killer.alive) {
      const kSocket = io.sockets.sockets.get(killer.id);
      if (kSocket) kSocket.emit('kill-confirm', { victim: p.name });
    }
    endMatchFor(match, socket.id, data.placement);
  });

  socket.on('disconnect', () => {
    const i = queue.findIndex(q => q.socket.id === socket.id);
    if (i >= 0) {
      queue.splice(i, 1);
      socket.data.inQueue = false;
      if (queue.length === 0 && queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    }
    const code = socket.data.room;
    if (code && matches.has(code)) {
      const match = matches.get(code);
      match.players.delete(socket.id);
      io.to(code).emit('remove-player', socket.id);
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

// Test end-to-end del servidor FAMOFIRE (cuentas + 2 jugadores reales)
const { io } = require('socket.io-client');

const URL = process.env.TEST_URL || 'http://localhost:3000';
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));
}

const A = io(URL, { reconnection: false });
const B = io(URL, { reconnection: false });
const got = { matchStart: [], moves: 0, damage: null, killConfirm: false, feed: 0, matchOver: null, matchEnd: false, removed: false, relogin: null, top100: false, zeroNotInTop: false, badpassProbe: false, duplicateName: false, zoneOk: false, idOk: false, idPersists: false, statsOk: false };

let A_id = null, B_id = null;
let registered = false;

const done = () => {
  setTimeout(() => {
    check('Registro de cuenta funciona (TESTA)', registered);
    check('Cuenta recibe un ID único al registrarse', got.idOk);
    check('El ID se conserva al volver a entrar (login)', got.idPersists);
    check('Cuenta suma estadisticas (1 partida, 2 bajas, 1 derrota)', got.statsOk);
    check('Nombres únicos sin importar mayúsculas (testa rechazado)', got.duplicateName);
    check('Login con contraseña incorrecta falla', got.badpassProbe);
    check('A recibe match-start (33 bots, mapa 3600x2000, zona incluida)', got.matchStart.length >= 1 &&
      got.matchStart.every(d => d.assignedBotsCount === 33 && d.mapW === 3600 && d.mapH === 2000 && d.you),
      JSON.stringify(got.matchStart[0] && { bots: got.matchStart[0].assignedBotsCount }));
    check('Zona de veneno viene del servidor (cierra en punto aleatorio)', got.zoneOk);
    check('Posiciones del jugador B llegan a A', got.moves > 0, got.moves + ' updates');
    check('B recibe receive-damage (25)', got.damage && got.damage.dmg === 25, JSON.stringify(got.damage));
    check('A recibe kill-confirm', got.killConfirm);
    check('Ambos reciben kill-feed', got.feed === 2, got.feed + ' eventos');
    check('B recibe match-over con la posición real (9)', got.matchOver && got.matchOver.placement === 9, JSON.stringify(got.matchOver));
    check('A NO recibe match-end falso (bots siguen vivos)', !got.matchEnd);
    check('A recibe remove-player (B murió)', got.removed);
    check('Cuenta guarda progreso (relogin con puntos)', got.relogin && got.relogin.points === 1650, JSON.stringify(got.relogin));
    check('Top100 incluye a TESTA con 1650', got.top100);
    check('Cuenta con 0 puntos NO aparece en el Top', got.zeroNotInTop);
    const failed = results.filter(r => !r.ok).length;
    A.close(); B.close();
    console.log(failed === 0 ? 'TODO OK' : `${failed} PRUEBA(S) FALLARON`);
    process.exit(failed === 0 ? 0 : 1);
  }, 1500);
};

A.on('connect', () => {
  A_id = A.id;
  A.emit('account-register', { name: 'TestA', password: 'clave123' });
});
A.on('account-result', (res) => {
  if (res.ok && res.account.name === 'TESTA' && res.account.points === 0) {
    registered = true;
    got.idOk = !!(res.account.id && res.account.id.length >= 6);
    got.testAId = res.account.id;
    // Intento de duplicar el nombre con distintas mayúsculas (debe fallar)
    const D = io(URL, { reconnection: false });
    D.on('connect', () => D.emit('account-register', { name: 'testa', password: 'otra123' }));
    D.on('account-result', (r) => {
      got.duplicateName = !r.ok && r.error === 'name-taken';
      D.close();
    });
    A.emit('account-login', { name: 'TestA', password: 'INCORRECTA' });
  } else if (!res.ok && res.error === 'bad-pass') {
    got.badpassProbe = true;
    A.emit('join-matchmaking', { name: 'TestA', points: 1500, color: '#ff0000' });
  }
});

B.on('connect', () => {
  B_id = B.id;
  B.emit('account-register', { name: 'TestB', password: 'clave123' });
});
B.on('account-result', (res) => {
  if (res.ok && res.account.name === 'TESTB') {
    B.emit('join-matchmaking', { name: 'TestB', points: 900, color: '#00ff00' });
  }
});

A.on('match-start', (d) => {
  got.matchStart.push(d);
  const z = d.zone;
  got.zoneOk = !!(z && z.targetRadius === 120 && z.maxRadius > 0 &&
    z.targetX >= 3600 * 0.2 && z.targetX <= 3600 * 0.8 &&
    z.targetY >= 2000 * 0.2 && z.targetY <= 2000 * 0.8 &&
    z.startDelay === 900 && z.duration === 5760);
  if (!A_id || !B_id) return;
  A.emit('player-move', { x: 500, y: 600, angle: 0.5 });
  B.emit('player-move', { x: 900, y: 800, angle: 1.2 });
  A.emit('player-shot', { x: 500, y: 600, angle: 0.5 });
  setTimeout(() => {
    A.emit('damage', { victimId: B_id, dmg: 25 });
  }, 300);
});
A.on('update-player-position', () => got.moves++);
A.on('update-room-players', () => {});
A.on('kill-confirm', () => {
  got.killConfirm = true;
  A.emit('account-update', { points: 1650, level: 3, exp: 40 });
  A.emit('match-results', { win: false, kills: 2, dmg: 50 });
  setTimeout(() => {
    const C = io(URL, { reconnection: false });
    C.on('connect', () => C.emit('account-login', { name: 'TestA', password: 'clave123' }));
    C.on('account-result', (r) => {
      if (r.ok) {
        got.relogin = r.account;
        got.idPersists = r.account.id === got.testAId;
        got.statsOk = r.account.matches === 1 && r.account.kills === 2 && r.account.wins === 0;
        // Crear una cuenta nueva con 0 puntos y pedir el Top: no debe aparecer
        const E = io(URL, { reconnection: false });
        E.on('connect', () => E.emit('account-register', { name: 'CERO' + Math.floor(Math.random() * 9999), password: 'clave123' }));
        E.on('account-result', (r2) => {
          if (r2.ok) {
            got.zeroName = r2.account.name;
            C.emit('get-top100');
            E.close();
          } else {
            C.emit('get-top100');
            E.close();
          }
        });
      }
    });
    C.on('update-top100', (top) => {
      got.top100 = top.some(p => p.name === 'TESTA' && p.points === 1650);
      got.zeroNotInTop = !top.some(p => p.name === got.zeroName);
      C.close();
      done();
    });
    setTimeout(() => C.close(), 5000);
  }, 400);
});
A.on('kill-feed', () => got.feed++);
A.on('match-end', () => { got.matchEnd = true; });
A.on('remove-player', (d) => {
  if (d && d.id === B_id) got.removed = true;
});

B.on('match-start', () => {});
B.on('receive-damage', (d) => { got.damage = d; B.emit('player-died', { killerId: A_id, placement: 9 }); });
B.on('kill-feed', () => got.feed++);
B.on('match-over', (d) => { got.matchOver = d; });

setTimeout(() => { check('timeout global', false, 'no se completó el flujo'); A.close(); B.close(); process.exit(1); }, 20000);

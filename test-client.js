// Test end-to-end del servidor FAMOFIRE (2 jugadores reales)
const { io } = require('socket.io-client');

const URL = process.env.TEST_URL || 'http://localhost:3000';
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : ''));
}

const A = io(URL, { reconnection: false });
const B = io(URL, { reconnection: false });
const got = { matchStart: [], moves: 0, damage: null, killConfirm: false, feed: 0, matchOver: null, matchEnd: false, top100: false };

let A_id = null, B_id = null;
const done = () => {
  setTimeout(() => {
    check('A recibe match-start (33 bots, mapa 3600x2000, con B en players)', got.matchStart.length >= 1 &&
      got.matchStart.every(d => d.assignedBotsCount === 33 && d.mapW === 3600 && d.mapH === 2000 && d.you),
      JSON.stringify(got.matchStart[0] && { bots: got.matchStart[0].assignedBotsCount, you: got.matchStart[0].you }));
    check('Posiciones del jugador B llegan a A', got.moves > 0, got.moves + ' updates');
    check('B recibe receive-damage (25)', got.damage && got.damage.dmg === 25, JSON.stringify(got.damage));
    check('A recibe kill-confirm', got.killConfirm);
    check('Ambos reciben kill-feed', got.feed === 2, got.feed + ' eventos');
    check('B recibe match-over con la posición real del cliente (9)', got.matchOver && got.matchOver.placement === 9, JSON.stringify(got.matchOver));
    check('A recibe match-end (victoria)', got.matchEnd);
    check('Top100 incluye a TestA', got.top100);
    const failed = results.filter(r => !r.ok).length;
    A.close(); B.close();
    console.log(failed === 0 ? 'TODO OK' : `${failed} PRUEBA(S) FALLARON`);
    process.exit(failed === 0 ? 0 : 1);
  }, 1500);
};

A.on('connect', () => {
  A_id = A.id;
  A.emit('player-join', { name: 'TestA', points: 1500, color: '#ff0000' });
  A.emit('join-matchmaking', { name: 'TestA', points: 1500, color: '#ff0000' });
});
B.on('connect', () => {
  B_id = B.id;
  B.emit('player-join', { name: 'TestB', points: 900, color: '#00ff00' });
  B.emit('join-matchmaking', { name: 'TestB', points: 900, color: '#00ff00' });
});

A.on('match-start', (d) => {
  got.matchStart.push(d);
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
A.on('kill-confirm', () => { got.killConfirm = true; A.emit('update-points', { points: 1650 }); });
A.on('kill-feed', () => got.feed++);
A.on('match-end', () => {
  got.matchEnd = true;
  A.emit('get-top100');
});

B.on('match-start', () => {});
B.on('receive-damage', (d) => { got.damage = d; B.emit('player-died', { killerId: A_id, placement: 9 }); });
B.on('kill-feed', () => got.feed++);
B.on('match-over', (d) => { got.matchOver = d; });

A.on('update-top100', (top) => {
  got.top100 = top.some(p => p.name === 'TestA' && p.points === 1650);
  done();
});

setTimeout(() => { check('timeout global', false, 'no se completó el flujo'); A.close(); B.close(); process.exit(1); }, 15000);

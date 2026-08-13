// Test e2e de las nuevas funciones: espectador, cuenta recordada y reinicio de entrenamiento
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const paths = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const exe = paths.find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, extra) => { results.push(ok); console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' | ' + extra : '')); };

const ctxA = await browser.createBrowserContext();
const ctxB = await browser.createBrowserContext();
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
const errA = [];
pageA.on('pageerror', e => errA.push(e.message.slice(0, 120)));

const register = async (page, name) => {
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 40000 });
  await page.waitForSelector('#username-input', { timeout: 20000 });
  await page.type('#username-input', name);
  await page.type('#password-input', 'clave123');
  await page.click('#register-btn');
  await page.waitForSelector('#lobby-screen', { visible: true, timeout: 15000 });
};

await register(pageA, 'SPECA');
await register(pageB, 'SPECB');

// Ambos entran a campo de batalla EN COLA AL MISMO TIEMPO (si se espera a que
// empiece la partida de uno, el otro recibe su propia partida en solitario)
const joinBattle = async (page) => {
  await page.click('#to-battlefield-btn');
  await page.waitForSelector('#to-battle-game-btn', { visible: true, timeout: 5000 });
  await page.click('#to-battle-game-btn');
};
await joinBattle(pageA);
await joinBattle(pageB);
await Promise.all([
  pageA.waitForFunction(() => gameStarted && currentMode === 'battlefield', { timeout: 30000 }),
  pageB.waitForFunction(() => gameStarted && currentMode === 'battlefield', { timeout: 30000 })
]);
// Invulnerables: en headless los bots alcanzan al jugador quieto en ~2s y lo
// matan antes de que B pueda disparar; así solo la muerte por B decide la prueba.
await pageA.evaluate(() => { player.hp = 100000; });
await pageB.evaluate(() => { player.hp = 100000; });

const idA = await pageA.evaluate(() => socket.id);

// B "camina" hasta la posición de A (el spawn es aleatorio y puede quedar a
// >560px, el alcance máximo del daño entre jugadores)
const bTarget = await pageB.evaluate((idA) => {
  const rp = remotePlayers[idA];
  if (!rp) return null;
  player.x = rp.x;
  player.y = rp.y;
  socket.emit('player-move', { matchId: currentMatchId, x: player.x, y: player.y, angle: 0 });
  return { x: rp.x, y: rp.y };
}, idA);
await new Promise(r => setTimeout(r, 300));

// B dispara 5 veces a A (25 de daño cada una, 90ms de separación -> muere)
await pageB.evaluate((idA) => {
  return new Promise(r => {
    let n = 0;
    const iv = setInterval(() => {
      n++;
      socket.emit('damage', { victimId: idA, dmg: 25 });
      if (n >= 5) { clearInterval(iv); r(); }
    }, 90);
  });
}, idA);

// A debe entrar en modo espectador viendo a SPECK... SPECB
let spectate = false;
try {
  await pageA.waitForSelector('#spectator-screen', { visible: true, timeout: 10000 });
  const name = await pageA.evaluate(() => document.querySelector('#spectate-name').textContent);
  spectate = name.trim() === 'SPECB';
  check('A entra a espectador de B tras morir', spectate, 'observando a: ' + name.trim());
} catch { check('A entra a espectador de B tras morir', false, 'no apareció #spectator-screen'); }

// B gana (match-won) y sale: la partida se cierra y A debe ver sus resultados
await pageB.evaluate(() => socket.emit('match-won', { kills: 0 }));
await new Promise(r => setTimeout(r, 700));
await pageB.evaluate(() => endGame(true));
let resultsShown = false;
try {
  await pageA.waitForSelector('#stats-screen', { visible: true, timeout: 15000 });
  resultsShown = true;
  const pos = await pageA.evaluate(() => document.querySelector('#stat-pos').textContent);
  const pts = await pageA.evaluate(() => document.querySelector('#stat-points').textContent);
  check('El espectador ve sus resultados al cerrarse la partida', resultsShown, pos + ' | ' + pts);
} catch { check('El espectador ve sus resultados al cerrarse la partida', false, 'no apareció #stats-screen'); }

// Reload: el juego debe recordar la cuenta y entrar solo
await pageA.reload({ waitUntil: 'networkidle2', timeout: 40000 });
let autoLogin = false;
try {
  await pageA.waitForSelector('#lobby-screen', { visible: true, timeout: 20000 });
  const nm = await pageA.evaluate(() => document.querySelector('#lobby-name').textContent);
  autoLogin = nm.trim() === 'SPECA';
  check('Recuerda usuario/contraseña y entra solo al recargar', autoLogin, 'entró como: ' + nm.trim());
} catch { check('Recuerda usuario/contraseña y entra solo al recargar', false, 'no entró solo'); }

// Entrenamiento: matar todos los bots muestra resultados y permite reiniciar
const ctxT = await browser.createBrowserContext();
const pageT = await ctxT.newPage();
await register(pageT, 'SPECT');
await pageT.click('#to-training-btn');
await pageT.waitForFunction(() => gameStarted && currentMode === 'training', { timeout: 15000 });
// Los 9 bots caen (se vacía el arreglo igual que al morir el último)
await pageT.evaluate(() => { enemies.length = 0; updateHUDCounters(); });
await new Promise(r => setTimeout(r, 200));
// El gancho de victoria se prueba disparando el flujo completo de endGame(true) + botón
await pageT.evaluate(() => endGame(true));
await pageT.waitForSelector('#stats-screen', { visible: true, timeout: 8000 });
const retryVisible = await pageT.evaluate(() => document.getElementById('retry-training-btn').style.display === 'block');
check('Victoria en entrenamiento: aparece opción de reiniciar', retryVisible);
await pageT.click('#retry-training-btn');
await pageT.waitForFunction(() => gameStarted && currentMode === 'training', { timeout: 8000 });
const botCount = await pageT.evaluate(() => enemies.length);
check('Reiniciar entrenamiento vuelve a meter los 9 bots', botCount === 9, botCount + ' bots');

const statsHiddenAfterRetry = await pageT.evaluate(() => document.getElementById('stats-screen').style.display === 'none');
check('Al reiniciar se cierra la pantalla de resultados', statsHiddenAfterRetry);

// Consola limpia en la página del espectador
check('Sin errores de consola en la página espectadora', errA.length === 0, errA.join(' | ') || 'limpio');

console.log(results.every(Boolean) ? 'TODO OK' : 'HUBO FALLOS');
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
// Test e2e del emparejamiento COMPARTIDO: el que se une tarde ve la misma
// cuenta atrás que el primero, y ambos entran a la MISMA partida (el otro es
// rival real, no un bot quieto).
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
const ctx1 = await browser.createBrowserContext();
const ctx2 = await browser.createBrowserContext();
const p1 = await ctx1.newPage();
const p2 = await ctx2.newPage();
const register = async (page, name) => {
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 40000 });
  await page.waitForSelector('#username-input', { timeout: 20000 });
  await page.type('#username-input', name);
  await page.type('#password-input', 'clave123');
  await page.click('#register-btn');
  await page.waitForSelector('#lobby-screen', { visible: true, timeout: 15000 });
};
await register(p1, 'MMUNO');
await register(p2, 'MMDOS');
const startQueue = async (page) => {
  await page.click('#to-battlefield-btn');
  await page.waitForSelector('#to-battle-game-btn', { visible: true, timeout: 5000 });
  await page.click('#to-battle-game-btn');
};
await startQueue(p1);
// P2 se une 2 segundos después (ya había cola abierta por MMUNO)
await new Promise(r => setTimeout(r, 2000));
await startQueue(p2);
await new Promise(r => setTimeout(r, 600));
const t1 = await p1.evaluate(() => document.getElementById('mm-timer').textContent);
const t2 = await p2.evaluate(() => document.getElementById('mm-timer').textContent);
check('El que se une tarde ve la MISMA cuenta atrás que el primero', t1 === t2, `${t1} vs ${t2}`);
const c1 = await p1.evaluate(() => document.getElementById('mm-status-text').textContent);
check('El contador de fila muestra a los 2 esperando', (c1.match(/2 en fila/) || []).length > 0, c1.slice(0, 70));
await Promise.all([
  p1.waitForFunction(() => gameStarted && currentMode === 'battlefield', { timeout: 30000 }),
  p2.waitForFunction(() => gameStarted && currentMode === 'battlefield', { timeout: 30000 })
]);
const mid1 = await p1.evaluate(() => currentMatchId);
const mid2 = await p2.evaluate(() => currentMatchId);
check('Ambos entran a la MISMA partida (mismo matchId)', mid1 === mid2, mid1);
const vis = await p1.evaluate(() => ({
  remote: Object.values(remotePlayers).map(r => r.name),
  botNames: enemies.map(e => e.name),
  enQty: enemies.length
}));
const otherSeen = vis.remote.includes('MMDOS');
const otherAsBot = vis.botNames.includes('MMDOS');
check('MMUNO ve a MMDOS como rival real (no como bot)', otherSeen && !otherAsBot, 'remotes: ' + vis.remote.join(',') + ' · bots: ' + vis.enQty);
const vis2 = await p2.evaluate(() => ({
  remote: Object.values(remotePlayers).map(r => r.name),
  botNames: enemies.map(e => e.name)
}));
const otherSeen2 = vis2.remote.includes('MMUNO');
const otherAsBot2 = vis2.botNames.includes('MMUNO');
check('MMDOS ve a MMUNO como rival real (no como bot)', otherSeen2 && !otherAsBot2, 'remotes: ' + vis2.remote.join(','));
console.log(results.every(Boolean) ? 'TODO OK' : 'HUBO FALLOS');
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
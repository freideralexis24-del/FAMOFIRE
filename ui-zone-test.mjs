import puppeteer from 'puppeteer-core';
import fs from 'fs';
const paths = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
const exe = paths.find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('[c] ' + m.text().slice(0, 150)); });
page.on('pageerror', e => errors.push('[p] ' + e.message.slice(0, 150)));
const check = (name, ok, extra) => console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));

await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 40000 });
await page.waitForSelector('#username-input', { timeout: 20000 });
await page.type('#username-input', 'SPECT');
await page.type('#password-input', 'clave123');
await page.click('#login-btn');
await page.waitForSelector('#lobby-screen', { visible: true, timeout: 15000 });

// --- Config: estructura (pestañas ARRIBA, botón atrás FUERA de las pestañas) ---
await page.click('#gear-btn');
await new Promise(r => setTimeout(r, 400));
const structure = await page.evaluate(() => {
  const screen = document.getElementById('config-screen');
  const tabs = document.querySelector('#config-screen .config-tabs');
  const footer = document.querySelector('#config-screen .config-footer');
  const back = document.getElementById('back-from-config');
  const visOn = document.getElementById('cfg-panel-visual').style.display !== 'none';
  const tabsAbove = tabs && footer && (tabs.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const tabTexts = [...document.querySelectorAll('.config-tab')].map(t => t.textContent);
  return { visOn, tabsAbove, footer: !!footer, tabTexts };
});
check('Pestañas arriba y botón REGRESAR fuera de ellas', structure.visOn && structure.tabsAbove && structure.footer && structure.tabTexts.length === 3, JSON.stringify(structure.tabTexts));

// --- Contenido profesional: filas con etiqueta + control ---
const rows = await page.evaluate(() => {
  const pan = document.getElementById('cfg-panel-visual');
  return { sections: pan.querySelectorAll('.cfg-section').length, rows: pan.querySelectorAll('.cfg-row').length, hints: pan.querySelectorAll('.cfg-row-hint').length };
});
check('Pest. VISUALES: secciones y filas con descripción', rows.sections === 2 && rows.rows === 3 && rows.hints === 3, JSON.stringify(rows));

await page.click('#cfg-tab-lang');
await new Promise(r => setTimeout(r, 250));
const langRows = await page.evaluate(() => ({
  sections: document.querySelectorAll('#cfg-panel-lang .cfg-section').length,
  cur: document.getElementById('cfg-lang-current').textContent
}));
check('Pest. IDIOMA/CONTROLES: muestra el idioma actual', langRows.sections === 2 && langRows.cur === 'ESPAÑOL', JSON.stringify(langRows));

await page.click('#cfg-tab-account');
await new Promise(r => setTimeout(r, 250));
const accRows = await page.evaluate(() => ({
  sections: document.querySelectorAll('#cfg-panel-account .cfg-section').length,
  badge: document.getElementById('account-badge').textContent,
  danger: document.querySelectorAll('#cfg-panel-account .cfg-danger').length
}));
check('Pest. CUENTA: insignia + zona de riesgo', accRows.sections === 3 && accRows.badge.length > 3 && accRows.danger === 2, JSON.stringify(accRows));

// El botón REGRESAR debe funcionar desde la pestaña CUENTA
await page.click('#back-from-config');
await new Promise(r => setTimeout(r, 300));
const backWorks = await page.evaluate(() => document.getElementById('lobby-screen').style.display === 'flex');
check('REGRESAR funciona desde cualquier pestaña', backWorks);

// --- Bots: miedo al veneno ---
await page.click('#to-battlefield-btn');
await page.waitForSelector('#to-battle-game-btn', { visible: true, timeout: 5000 });
await page.click('#to-battle-game-btn');
await page.waitForFunction(() => gameStarted && currentMode === 'battlefield', { timeout: 30000 });
await new Promise(r => setTimeout(r, 600));
await page.evaluate(() => {
  safeZone.timer = safeZone.startDelay + safeZone.duration * 0.6;
  const p = (safeZone.timer - safeZone.startDelay) / safeZone.duration;
  safeZone.radius = safeZone.maxRadius * (1 - p) + safeZone.targetRadius * p;
  safeZone.x = safeZone.startX + (safeZone.targetX - safeZone.startX) * p;
  safeZone.y = safeZone.startY + (safeZone.targetY - safeZone.startY) * p;
  const b = enemies[0];
  b.x = safeZone.x + safeZone.radius + 400;
  b.y = safeZone.y;
});
let prev = null, toward = 0, total = 0;
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 250));
  const s = await page.evaluate(() => { const b = enemies[0]; return { x: b.x, y: b.y, zx: safeZone.x, zy: safeZone.y }; });
  if (prev) {
    const dx = s.x - prev.x, dy = s.y - prev.y;
    const tzx = s.zx - prev.x, tzy = s.zy - prev.y;
    const l = Math.hypot(tzx, tzy);
    const vl = Math.hypot(dx, dy);
    if (vl > 0.01 && l > 0) { total++; const dot = (dx * tzx / l + dy * tzy / l) / vl; if (dot > 0.35) toward++; }
  }
  prev = s;
}
check('Bots huyen de la zona hacia el centro', total >= 8 && toward >= total * 0.8, `${toward}/${total} muestras hacia el centro`);
check('Sin errores de consola', errors.length === 0, errors.join(' | ') || 'limpio');
console.log('---');
await browser.close();
process.exit(0);
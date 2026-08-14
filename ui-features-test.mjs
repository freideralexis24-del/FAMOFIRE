import puppeteer from 'puppeteer-core';
import fs from 'fs';

const paths = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
const exe = paths.find(p => fs.existsSync(p));
if (!exe) { console.log('NO BROWSER'); process.exit(1); }
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message.slice(0, 200)));
const check = (name, ok, extra) => console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));

await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 40000 });
await new Promise(r => setTimeout(r, 1200));

// 1) Login con cuenta que NO existe -> mensaje "no existe", sin crear nada
await page.type('#username-input', 'NADIE_EXISTE_9999');
await page.type('#password-input', 'x123');
await page.click('#login-btn');
await new Promise(r => setTimeout(r, 900));
const noExistMsg = await page.evaluate(() => document.getElementById('login-msg').textContent);
check('Cuenta inexistente: mensaje de que NO existe', /no existe|doesn't exist|不存在|não existe/i.test(noExistMsg), noExistMsg);

// 2) Pestañas de Configuración
const name1 = 'UIV' + Date.now().toString(36).slice(-6).toUpperCase();
await page.click('#guest-btn');
await page.type('#guest-name-input', name1);
await page.type('#guest-pass-input', 'clave123');
await page.click('#guest-confirm-btn');
await page.waitForFunction(() => document.getElementById('lobby-screen').style.display === 'flex', { timeout: 12000 });
await page.click('#gear-btn');
await new Promise(r => setTimeout(r, 400));
const tabs = await page.evaluate(() => ({
  vis: document.getElementById('cfg-panel-visual').style.display,
  lang: document.getElementById('cfg-panel-lang').style.display,
  acc: document.getElementById('cfg-panel-account').style.display,
  tabVis: document.getElementById('cfg-tab-visual').className
}));
check('Config abre en pestaña VISUALES', tabs.vis === 'block' && tabs.lang === 'none' && tabs.acc === 'none' && tabs.tabVis.includes('active'), JSON.stringify(tabs));
await page.click('#cfg-tab-lang');
await new Promise(r => setTimeout(r, 200));
const langTab = await page.evaluate(() => ({
  vis: document.getElementById('cfg-panel-visual').style.display,
  lang: document.getElementById('cfg-panel-lang').style.display,
  tab: document.getElementById('cfg-tab-lang').className
}));
check('Cambiar a pestaña IDIOMA/CONTROLES', langTab.vis === 'none' && langTab.lang === 'block' && langTab.tab.includes('active'));
await page.click('#cfg-tab-account');
await new Promise(r => setTimeout(r, 200));
const accTab = await page.evaluate(() => ({
  lang: document.getElementById('cfg-panel-lang').style.display,
  acc: document.getElementById('cfg-panel-account').style.display,
  tab: document.getElementById('cfg-tab-account').className
}));
check('Cambiar a pestaña CUENTA', accTab.lang === 'none' && accTab.acc === 'block' && accTab.tab.includes('active'));
await page.click('#back-from-config');
await new Promise(r => setTimeout(r, 300));

// 3) Avatar en tiempo real
await page.click('#to-skins-btn');
await page.waitForFunction(() => document.getElementById('tab-avatar-content') !== null, { timeout: 5000 });
await page.evaluate(() => { const btns = document.querySelectorAll('.avatar-option'); if (btns.length) btns[3].click(); });
await new Promise(r => setTimeout(r, 300));
const avatarSynced = await page.evaluate(() => {
  const chosen = profile.avatar;
  return { chosen, lobby: document.getElementById('profile-avatar').textContent, big: document.getElementById('profile-avatar-big').textContent };
});
check('Avatar se actualiza en vivo (sala de comando + perfil)', avatarSynced.chosen === avatarSynced.lobby && avatarSynced.chosen === avatarSynced.big, JSON.stringify(avatarSynced));
await page.evaluate(() => document.getElementById('back-from-skins').click());
await new Promise(r => setTimeout(r, 300));

// 4) Música: apagar/encender sin errores y con estado correcto
const musicBefore = await page.evaluate(() => ({ pref: profile.music, playing: !document.getElementById('audio-lobby').paused }));
await page.click('#gear-btn');
await new Promise(r => setTimeout(r, 300));
await page.click('#toggle-music-btn');
await new Promise(r => setTimeout(r, 300));
const musicOff = await page.evaluate(() => ({ pref: profile.music, paused: document.getElementById('audio-lobby').paused, label: document.getElementById('music-status-label').textContent }));
await page.click('#toggle-music-btn');
await new Promise(r => setTimeout(r, 400));
const musicOn = await page.evaluate(() => ({ pref: profile.music, paused: document.getElementById('audio-lobby').paused, label: document.getElementById('music-status-label').textContent, pending: typeof musicPendingStart !== 'undefined' ? musicPendingStart : 'na' }));
check('Música: apagar pausa y actualiza etiqueta', musicOff.pref === false && musicOff.paused && /DESACTIVADA|OFF|已关闭|DESATIVADA/i.test(musicOff.label));
check('Música: reactivar vuelve a sonar (o queda pendiente de desbloqueo)', musicOn.pref === true && (musicOn.paused === false || musicOn.pending === true) && /ACTIVADA|ON|已开启|ATIVADA/i.test(musicOn.label));
console.log('DEBUG musicaOn:', JSON.stringify(musicOn), '| antes:', JSON.stringify(musicBefore));

// 5) Sin errores de consola
check('Sin errores de consola', errors.length === 0, errors.join(' | ') || 'limpio');

console.log('---');
await browser.close();
process.exit(0);
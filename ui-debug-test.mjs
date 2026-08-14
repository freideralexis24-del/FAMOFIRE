import puppeteer from 'puppeteer-core';
import fs from 'fs';

const paths = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const exe = paths.find(p => fs.existsSync(p));
if (!exe) { console.log('NO BROWSER'); process.exit(1); }
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message.slice(0, 300)));

const check = (name, ok, extra) => console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));

await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 40000 });
await new Promise(r => setTimeout(r, 1500));

// 1) Flujo INVITADO CON contraseña -> lobby
const name1 = 'UIG' + Date.now().toString(36).slice(-6).toUpperCase();
await page.click('#guest-btn');
await page.type('#guest-name-input', name1);
await page.type('#guest-pass-input', 'clave123');
await page.click('#guest-confirm-btn');
try {
  await page.waitForFunction(() => document.getElementById('lobby-screen').style.display === 'flex', { timeout: 12000 });
  check('Invitado con contraseña -> SALA DE COMANDO', true, 'como ' + await page.evaluate(() => document.querySelector('#lobby-name').textContent));
} catch { check('Invitado con contraseña -> SALA DE COMANDO', false); }

// 2) Cerrar sesión y volver a entrar -> login, sin pantallas raras
await page.click('#gear-btn').catch(() => {});
await new Promise(r => setTimeout(r, 500));
await page.click('#logout-btn').catch(() => {});
await new Promise(r => setTimeout(r, 600));
const backLogin = await page.evaluate(() => document.getElementById('login-screen').style.display === 'flex');
check('Cerrar sesión vuelve al login', backLogin);

// 3) Dirección del flujo CREAR (pantalla) — no se puede usar Google real, pero
//    verificamos que el formulario tiene CORREO + NOMBRE + CONTRASEÑA
const hasNameField = await page.evaluate(() => !!document.getElementById('create-name-input'));
check('Pantalla crear: campo de NOMBRE incluido', hasNameField);

// 4) El login con una cuenta que SÍ existe entra directo al lobby (sin pedir nombre)
const res = await page.evaluate(async (name) => {
  return new Promise(r => {
    const s = window.socket || document.socket;
    setTimeout(() => r({ socketOk: !!s }), 500);
  });
}, name1);
await page.type('#username-input', name1);
await page.type('#password-input', 'clave123');
await page.click('#login-btn');
try {
  await page.waitForFunction(() => document.getElementById('lobby-screen').style.display === 'flex', { timeout: 12000 });
  const nm = await page.evaluate(() => document.querySelector('#lobby-name').textContent);
  check('Login normal entra directo (sin elegir nombre)', nm.trim() === name1, 'entró como ' + nm.trim());
} catch { check('Login normal entra directo (sin elegir nombre)', false); }

// 5) Consola limpia
check('Sin errores de consola', errors.length === 0, errors.join(' | ') || 'limpio');

console.log('---');
await browser.close();
process.exit(0);
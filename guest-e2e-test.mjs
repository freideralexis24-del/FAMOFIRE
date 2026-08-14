import { io } from 'socket.io-client';

const BASE = process.env.TEST_BASE || 'http://localhost:3000';

function call(socket, event, ackEvent, data, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + event)), timeoutMs);
    socket.once(ackEvent, (res) => { clearTimeout(timer); resolve(res); });
    socket.emit(event, data);
  });
}

const results = [];
function check(label, cond) {
  results.push({ label, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label);
}

const nameG = 'GV' + Math.random().toString(36).slice(2, 8).toUpperCase();
const nameN = 'NV' + Math.random().toString(36).slice(2, 8).toUpperCase();
const device = 'dev-' + Date.now();

const s = io(BASE, { reconnection: false, transports: ['websocket'] });
s.on('connect_error', (e) => { console.error('CONNECT_ERROR', e.message); process.exit(1); });

s.on('connect', async () => {
  try {
    // 1) INVITADO CON CONTRASEÑA
    let r = await call(s, 'guest-register', 'account-result', { name: nameG, password: 'pass123', deviceToken: device });
    check('1 invitado con contrasena creado', r.ok);
    let accName = r.account.name;

    let ln = await call(s, 'account-login', 'account-result', { name: accName, password: 'pass123' });
    check('2 login invitado por NOMBRE', ln.ok && ln.account && ln.account.name === accName);

    ln = await call(s, 'account-login', 'account-result', { name: accName.toLowerCase() + '@x.com', password: 'pass123' });
    check('3 login por correo falso -> not-found', !ln.ok && ln.error === 'not-found');

    // 2) INVITADO SIN CONTRASEÑA
    r = await call(s, 'guest-register', 'account-result', { name: nameN, password: '', deviceToken: device });
    check('4 invitado sin contrasena creado', r.ok && r.hasPassword === false);

    r = await call(s, 'account-login', 'account-result', { name: nameN, password: 'x' });
    check('5 login normal a invitado sin pass -> needs-device', !r.ok && r.error === 'needs-device');

    r = await call(s, 'guest-login', 'account-result', { name: nameN, deviceToken: device });
    check('6 guest-login mismo dispositivo OK', r.ok);

    r = await call(s, 'guest-login', 'account-result', { name: nameN, deviceToken: 'otro-dispositivo' });
    check('7 guest-login otro dispositivo -> device-only', !r.ok && r.error === 'device-only');

    r = await call(s, 'guest-login', 'account-result', { name: nameG, deviceToken: device });
    check('8 guest-login a cuenta CON pass -> has-password', !r.ok && r.error === 'has-password');

    // 3) PONER CONTRASEÑA a invitado sin pass (Configuracion)
    r = await call(s, 'account-set-password', 'account-password-set', { currentPassword: '', newPassword: 'nueva123' });
    check('9 poner contrasena a invitado sin pass', r.ok);
    ln = await call(s, 'account-login', 'account-result', { name: nameN, password: 'nueva123' });
    check('10 login con contrasena nueva', ln.ok);
    r = await call(s, 'account-set-password', 'account-password-set', { currentPassword: 'mal', newPassword: 'otra123' });
    check('11 cambiar pass con actual incorrecta -> bad-pass', !r.ok && r.error === 'bad-pass');
    r = await call(s, 'account-set-password', 'account-password-set', { currentPassword: 'nueva123', newPassword: 'otra123' });
    check('12 cambiar pass con actual correcta', r.ok);

    // 4) RECUPERACION: invitado SIN correo -> no-email
    r = await call(s, 'request-password-reset', 'password-reset-requested', { name: nameN });
    check('13 recuperacion de invitado sin correo -> no-email', !r.ok && r.error === 'no-email');
    process.exit(0);
  } catch (e) {
    console.error('ERROR', e.message);
    process.exit(1);
  }
});
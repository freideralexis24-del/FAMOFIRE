import { io } from 'socket.io-client';

const BASE = process.env.TEST_BASE || 'http://localhost:3000';
const NAME = process.env.TEST_NAME || '';
const EMAIL = 'capitan.gogle@test.com';

function call(socket, event, ackEvent, data, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + event)), timeoutMs);
    socket.once(ackEvent, (res) => { clearTimeout(timer); resolve(res); });
    socket.emit(event, data);
  });
}

const results = [];
function check(label, cond) { results.push(label); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + label); }

const s = io(BASE, { reconnection: false, transports: ['websocket'] });
s.on('connect_error', (e) => { console.error('CONNECT_ERROR', e.message); process.exit(1); });

s.on('connect', async () => {
  try {
    let r = await call(s, 'account-login', 'account-result', { name: EMAIL, password: 'ggpass123' });
    check('14 login por CORREO (exacto)', r.ok && r.account.googleEmail === EMAIL && r.google === true && r.hasPassword === true);

    let r2 = await call(s, 'account-login', 'account-result', { name: 'CAPITAN.GOGLE@TEST.COM', password: 'ggpass123' });
    check('15 login por CORREO (mayusculas)', r2.ok);

    r = await call(s, 'account-login', 'account-result', { name: 'capitan.gogle@otro.com', password: 'ggpass123' });
    check('16 correo equivocado', !r.ok && r.error === 'not-found');

    let rr = await call(s, 'request-password-reset', 'password-reset-requested', { name: EMAIL });
    check('17 recuperacion por CORREO', rr.ok && !!rr.resetUrl);

    const token = new URL(rr.resetUrl).searchParams.get('reset');

    rr = await call(s, 'request-password-reset', 'password-reset-requested', { name: NAME.toLowerCase() });
    check('18 recuperacion por NOMBRE del soldado', rr.ok);

    r = await call(s, 'password-reset', 'password-reset-result', { token, newPassword: 'nuevapass9' });
    check('19 aplicar nueva contrasena con el enlace', r.ok);

    r = await call(s, 'account-login', 'account-result', { name: EMAIL, password: 'nuevapass9' });
    check('20 login con contrasena nueva', r.ok);

    r = await call(s, 'account-login', 'account-result', { name: EMAIL, password: 'ggpass123' });
    check('21 la vieja ya no sirve', !r.ok && r.error === 'bad-pass');

    r = await call(s, 'account-delete', 'account-deleted', { password: 'nuevapass9' });
    check('22 eliminar cuenta con contrasena', r.ok);
    process.exit(0);
  } catch (e) {
    console.error('ERROR', e.message);
    process.exit(1);
  }
});
import { io } from 'socket.io-client';

const BASE = process.env.TEST_BASE || 'http://localhost:3000';
const name = process.env.TEST_NAME || '';

function call(socket, event, ackEvent, data, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('timeout: ' + event)); }, timeoutMs);
    socket.once(ackEvent, (res) => { clearTimeout(timer); resolve(res); });
    socket.emit(event, data);
  });
}

const socket = io(BASE, { reconnection: false, transports: ['websocket'] });

socket.on('connect_error', (e) => { console.error('CONNECT_ERROR', e.message); process.exit(1); });

socket.on('connect', async () => {
  try {
    const rr = await call(socket, 'request-password-reset', 'password-reset-requested', { name });
    console.log('1) request ok=' + rr.ok + ' error=' + (rr.error || '') + ' emailed=' + rr.emailed + ' hasUrl=' + !!rr.resetUrl);
    if (!rr.resetUrl) throw new Error('No resetUrl');
    const token = new URL(rr.resetUrl).searchParams.get('reset');
    console.log('   tokenLen=' + token.length);

    const pw = await call(socket, 'password-reset', 'password-reset-result', { token, newPassword: 'newpass999' });
    console.log('2) reset ok=' + pw.ok + ' error=' + (pw.error || ''));

    const ln = await call(socket, 'account-login', 'account-result', { name, password: 'newpass999' });
    console.log('3) loginNUEVA ok=' + ln.ok + ' error=' + (ln.error || ''));

    const lo = await call(socket, 'account-login', 'account-result', { name, password: 'oldpass123' });
    console.log('4) loginVIEJA ok=' + lo.ok + ' error=' + (lo.error || ''));

    process.exit(0);
  } catch (e) {
    console.error('ERROR', e.message);
    process.exit(1);
  }
});
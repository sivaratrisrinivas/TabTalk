const { startServer, stopServer } = require('../server');
const { io } = require('socket.io-client');

describe('signaling server', () => {
  let url;

  beforeAll(async () => {
    await startServer(3101);
    url = 'http://localhost:3101';
  });

  afterAll(async () => {
    await stopServer();
  });

  test('room-based relay forwards messages', async () => {
    const room = 'jest-room';
    const a = io(url, { transports: ['websocket'] });
    const b = io(url, { transports: ['websocket'] });

    await new Promise((res) => a.on('connect', res));
    await new Promise((res) => b.on('connect', res));

    const aJoined = new Promise((res) => a.on('joined', r => r === room && res(null)));
    const bJoined = new Promise((res) => b.on('joined', r => r === room && res(null)));
    a.emit('join', room);
    b.emit('join', room);
    await Promise.all([aJoined, bJoined]);

    const probe = { type: 'offer', offer: { sdp: 'x', type: 'offer' }, room };

    const received = new Promise((res) => {
      b.on('message', (msg) => res(msg));
    });
    a.emit('message', probe);
    const msg = await Promise.race([received, timeout(2000)]);
    expect(msg.type).toBe('offer');
    expect(msg.offer.type).toBe('offer');

    a.close();
    b.close();
  });
});

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}



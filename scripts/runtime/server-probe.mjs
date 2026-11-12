import net from 'node:net';

export function varInt(value) {
  const bytes = [];
  do { const next = value & 127; value >>>= 7; bytes.push(value ? next | 128 : next); } while (value);
  return Buffer.from(bytes);
}
function readVarInt(buffer, start = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (start + i >= buffer.length) return null;
    const byte = buffer[start + i]; value |= (byte & 127) << (i * 7);
    if (!(byte & 128)) return { value, end: start + i + 1 };
  }
  throw new Error('Invalid status packet length');
}
const frame = payload => Buffer.concat([varInt(payload.length), payload]);

// Status handshakes never log in or occupy a bot identity.
export function probeServer(host, port, timeoutMs = 3000) {
  const started = Date.now();
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let data = Buffer.alloc(0), finished = false;
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy();
      resolve({ observedAt: new Date().toISOString(), latencyMs: Date.now() - started, ...result });
    };
    const timer = setTimeout(() => finish({ healthy: false, error: 'Minecraft status query timed out' }), timeoutMs);
    socket.once('connect', () => {
      const address = Buffer.from(host), targetPort = Buffer.alloc(2); targetPort.writeUInt16BE(port);
      socket.write(Buffer.concat([frame(Buffer.concat([varInt(0), varInt(772), varInt(address.length), address, targetPort, varInt(1)])), frame(varInt(0))]));
    });
    socket.on('data', chunk => {
      try {
        data = Buffer.concat([data, chunk]);
        if (data.length > 1024 * 1024) throw new Error('Minecraft status response is too large');
        const size = readVarInt(data);
        if (!size) return;
        if (size.value < 1 || size.value > 1024 * 1024) throw new Error('Invalid status response size');
        if (data.length < size.end + size.value) return;
        const packet = data.subarray(size.end, size.end + size.value), id = readVarInt(packet);
        if (!id || id.value !== 0) throw new Error('Unexpected Minecraft status packet');
        const length = readVarInt(packet, id.end);
        if (!length || length.end + length.value !== packet.length) throw new Error('Invalid Minecraft status JSON length');
        const status = JSON.parse(packet.subarray(length.end).toString('utf8'));
        if (!Number.isInteger(status.version?.protocol) || !Number.isFinite(status.players?.online)) throw new Error('Invalid Minecraft status response');
        finish({ healthy: true, version: status.version, players: { online: status.players.online, max: status.players.max } });
      } catch (error) { finish({ healthy: false, error: error.message }); }
    });
    socket.once('error', error => finish({ healthy: false, error: error.code ?? error.message }));
    socket.once('close', () => finish({ healthy: false, error: 'Minecraft status connection closed without a response' }));
  });
}

export function recoveryReason({ proxy, direct, sessions, failures, elapsedMs, cooldownMs }) {
  if (failures < 3 || elapsedMs < 60000 || cooldownMs < 300000) return null;
  if (sessions.some(session => session.connected)) return null;
  // A stale/unverified client cannot be used to justify interrupting the shared proxy.
  if (!sessions.length || sessions.some(session => !session.fresh)) return null;
  if (!direct?.healthy || proxy?.healthy) return null;
  return 'Direct server status works, proxy status failed repeatedly, and every active session is disconnected';
}

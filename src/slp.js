// Server List Ping для Java-серверов (1.7+): онлайн, описание, версия, иконка, пинг
const net = require('net');

function varint(n) {
  const out = [];
  n >>>= 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('bad varint');
  }
  return null; // не хватает данных
}

const packet = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([varint(body.length), body]);
};
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(b.length), b]); };

// описание сервера бывает строкой или «чат-компонентом»
function flatten(d) {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(flatten).join('');
  return (d.text || '') + (d.extra ? d.extra.map(flatten).join('') : '');
}

function ping(host, port = 25565, timeout = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let finished = false;
    const done = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ online: false }), timeout);

    sock.on('connect', () => {
      const port16 = Buffer.alloc(2);
      port16.writeUInt16BE(port);
      sock.write(packet(varint(0), varint(767), str(host), port16, varint(1))); // handshake
      sock.write(packet(varint(0))); // status request
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        let off = len.size;
        const id = readVarint(buf, off); off += id.size;
        const sl = readVarint(buf, off); off += sl.size;
        const info = JSON.parse(buf.slice(off, off + sl.value).toString('utf8'));
        done({
          online: true,
          ping: Date.now() - started,
          motd: flatten(info.description).replace(/§./g, '').trim(),
          version: info.version?.name || '',
          protocol: info.version?.protocol,
          players: info.players?.online ?? 0,
          max: info.players?.max ?? 0,
          favicon: typeof info.favicon === 'string' && info.favicon.startsWith('data:image/') ? info.favicon : null
        });
      } catch {
        done({ online: false });
      }
    });
    sock.on('error', () => done({ online: false }));
    sock.on('close', () => done({ online: false }));
  });
}

// SRV-запись (_minecraft._tcp.host) — многие сервера указывают порт через неё
async function resolveSrv(host) {
  try {
    const recs = await require('dns').promises.resolveSrv(`_minecraft._tcp.${host}`);
    if (recs[0]) return { host: recs[0].name, port: recs[0].port };
  } catch { /* SRV нет */ }
  return null;
}

module.exports = { ping, resolveSrv };

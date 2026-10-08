import { createConnection } from 'node:net';

export function bouyomiSpeak(text, config, signal) {
  if (config.bouyomiCommunication === 'http') return bouyomiHttp(text, config, signal);
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const body = Buffer.from(text, 'utf8'); const header = Buffer.alloc(15);
    header.writeInt16LE(1, 0); header.writeInt16LE(config.bouyomiUseDefaults ? -1 : Math.round(config.speed * 100), 2);
    header.writeInt16LE(config.bouyomiUseDefaults ? -1 : config.bouyomiTone ?? -1, 4); header.writeInt16LE(config.bouyomiUseDefaults ? -1 : Math.round(config.volume * 100), 6);
    header.writeInt16LE(config.bouyomiUseDefaults ? 0 : config.bouyomiVoice ?? 0, 8); header.writeUInt8(0, 10); header.writeInt32LE(body.length, 11);
    const socket = createConnection({ host: config.bouyomiHost, port: config.bouyomiPort });
    const abort = () => socket.destroy(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true }); socket.setTimeout(5000, () => socket.destroy(new Error('棒読みちゃんに接続できません')));
    socket.once('connect', () => socket.end(Buffer.concat([header, body])));
    socket.once('error', reject); socket.once('close', hadError => { signal?.removeEventListener('abort', abort); if (!hadError) resolve(); });
  });
}

async function bouyomiHttp(text, config, signal) {
  const url = new URL(`http://${config.bouyomiHost}:${config.bouyomiHttpPort}/talk`);
  url.searchParams.set('text', text); url.searchParams.set('speed', config.bouyomiUseDefaults ? -1 : Math.round(config.speed * 100));
  url.searchParams.set('tone', config.bouyomiUseDefaults ? -1 : config.bouyomiTone); url.searchParams.set('volume', config.bouyomiUseDefaults ? -1 : Math.round(config.volume * 100)); url.searchParams.set('voice', config.bouyomiUseDefaults ? 0 : config.bouyomiVoice);
  const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`棒読みちゃんHTTP: ${response.status}`);
}

import { parentPort, workerData } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';
import { VoiceWorkerRuntime } from '../apps/desktop/runtime/voice-worker-runtime.mjs';
import Opus from '../apps/desktop/runtime/opus-codec.mjs';

// A loopback peer observes the actual worker/player/Opus chain without a Discord
// account. Its clock is independent of the deliberately stalled app thread.
if (workerData.role === 'observer') {
  const socket = dgram.createSocket('udp4'), decoder = new Opus(); let samples = [], previous = 0, peak = 0;
  socket.on('message', packet => {
    const now = performance.now(), pcm = decoder.decode(packet);
    let energy = 0; for (let i = 0; i < pcm.length; i += 2) { const value = pcm.readInt16LE(i); energy += value * value; peak = Math.max(peak, Math.abs(value)); }
    const rms = Math.sqrt(energy / (pcm.length / 2));
    samples.push({ gap: previous ? now - previous : 0, rms }); previous = now;
  });
  parentPort.on('message', message => {
    if (message.type === 'reset') { samples = []; previous = 0; peak = 0; parentPort.postMessage({ reset: true }); }
    if (message.type === 'report') { parentPort.postMessage({ samples, peak }); }
    if (message.type === 'stop') { socket.close(); decoder.delete(); parentPort.close(); }
  });
  socket.bind(0, '127.0.0.1', () => parentPort.postMessage({ port: socket.address().port }));
} else {
  const socket = dgram.createSocket('udp4');
  const runtime = new VoiceWorkerRuntime(parentPort, { join: options => {
    const connection = new EventEmitter(), speaking = new EventEmitter(); speaking.users = new Map();
    Object.assign(connection, { state: { status: 'ready' }, joinConfig: options, receiver: { speaking },
      subscribe: player => { connection.subscription = player.subscribe(connection); return connection.subscription; },
      onSubscriptionRemoved: subscription => subscription.player.unsubscribe(subscription),
      prepareAudioPacket: packet => { connection.packet = packet; },
      dispatchAudio: () => { if (connection.packet) socket.send(connection.packet, workerData.port, '127.0.0.1'); },
      setSpeaking() {}, rejoin: values => { Object.assign(connection.joinConfig, values); return true; },
      destroy: () => { connection.state = { status: 'destroyed' }; connection.subscription?.unsubscribe(); connection.adapter.destroy(); },
    });
    connection.adapter = options.adapterCreator({ onVoiceServerUpdate() {}, onVoiceStateUpdate() {}, destroy: () => connection.destroy() });
    connection.adapter.sendPayload({ op: 4, d: { guild_id: options.guildId, channel_id: options.channelId } });
    return connection;
  } });
  parentPort.on('close', () => socket.close());
}

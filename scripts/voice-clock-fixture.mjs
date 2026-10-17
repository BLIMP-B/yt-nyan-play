import { parentPort, workerData } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';
import { VoiceWorkerRuntime } from '../apps/desktop/runtime/voice-worker-runtime.mjs';
import Opus from '../apps/desktop/runtime/opus-codec.mjs';
import { PcmMixer } from '../apps/desktop/runtime/voice-output.mjs';

// A loopback peer observes the actual worker/player/Opus chain without a Discord
// account. Its clock is independent of the deliberately stalled app thread.
if (workerData.role === 'observer') {
  const socket = dgram.createSocket('udp4'), decoder = new Opus(); let samples = [], previous = 0, peak = 0, tokens = 360, budgetAt = performance.now(), shapedDrops = 0, sequenceErrors = 0, lastSequence, lastTimestamp;
  socket.on('message', packet => {
    const now = performance.now();
    if (workerData.rtp) {
      const sequence = packet.readUInt16BE(2), timestamp = packet.readUInt32BE(4);
      if (lastSequence !== undefined && (sequence !== (lastSequence + 1) % 65536 || timestamp !== ((lastTimestamp + 960) >>> 0))) sequenceErrors++;
      lastSequence = sequence; lastTimestamp = timestamp; packet = packet.subarray(12);
    }
    if (workerData.shaped) { tokens = Math.min(360, tokens + (now - budgetAt) * 10); budgetAt = now; if (tokens < packet.length + 60) { shapedDrops++; return; } tokens -= packet.length + 60; }
    const pcm = decoder.decode(packet);
    let energy = 0; for (let i = 0; i < pcm.length; i += 2) { const value = pcm.readInt16LE(i); energy += value * value; peak = Math.max(peak, Math.abs(value)); }
    const rms = Math.sqrt(energy / (pcm.length / 2));
    let crossings = 0; for (let i = 4; i < pcm.length; i += 4) if ((pcm.readInt16LE(i) >= 0) !== (pcm.readInt16LE(i - 4) >= 0)) crossings++;
    samples.push({ gap: previous ? now - previous : 0, rms, frequency: crossings * 48000 / (2 * (pcm.length / 4)) }); previous = now;
  });
  parentPort.on('message', message => {
    if (message.type === 'reset') { samples = []; previous = 0; peak = 0; tokens = 360; budgetAt = performance.now(); shapedDrops = 0; sequenceErrors = 0; lastSequence = undefined; parentPort.postMessage({ reset: true }); }
    if (message.type === 'report') { parentPort.postMessage({ samples, peak, shapedDrops, sequenceErrors }); }
    if (message.type === 'stop') { socket.close(); decoder.delete(); parentPort.close(); }
  });
  socket.bind(0, '127.0.0.1', () => parentPort.postMessage({ port: socket.address().port }));
} else {
  const socket = dgram.createSocket('udp4');
  const runtime = new VoiceWorkerRuntime(parentPort, { paced: workerData.paced !== false,
    ...(workerData.mediaBufferMs ? { createMixer: profile => new PcmMixer(profile, { mediaBufferMs: workerData.mediaBufferMs }) } : {}), join: options => {
    const connection = new EventEmitter(), speaking = new EventEmitter(); speaking.users = new Map();
    let sequence = 65532, timestamp = (4294967296 - 3840) >>> 0;
    Object.assign(connection, { state: { status: 'ready' }, joinConfig: options, receiver: { speaking },
      subscribe: player => { connection.subscription = player.subscribe(connection); return connection.subscription; },
      onSubscriptionRemoved: subscription => subscription.player.unsubscribe(subscription),
      prepareAudioPacket: packet => {
        if (!workerData.rtp) { connection.packet = packet; return; }
        const header = Buffer.alloc(12); header[0] = 128; header[1] = 120; header.writeUInt16BE(sequence, 2); header.writeUInt32BE(timestamp, 4); header.writeUInt32BE(Number(options.guildId), 8); connection.packet = Buffer.concat([header, packet]);
      },
      dispatchAudio: () => { if (!connection.packet) return false; socket.send(connection.packet, workerData.ports?.[options.guildId] || workerData.port, '127.0.0.1'); connection.packet = null; sequence = (sequence + 1) % 65536; timestamp = (timestamp + 960) >>> 0; return true; },
      setSpeaking() {}, rejoin: values => { Object.assign(connection.joinConfig, values); return true; },
      destroy: () => { connection.state = { status: 'destroyed' }; connection.subscription?.unsubscribe(); connection.adapter.destroy(); },
    });
    connection.adapter = options.adapterCreator({ onVoiceServerUpdate() {}, onVoiceStateUpdate() {}, destroy: () => connection.destroy() });
    connection.adapter.sendPayload({ op: 4, d: { guild_id: options.guildId, channel_id: options.channelId } });
    return connection;
  } });
  const stall = workerData.senderStallMs ? setInterval(() => { const until = performance.now() + workerData.senderStallMs; while (performance.now() < until) {} }, 500) : null;
  if (stall) stall.unref();
  parentPort.on('close', () => socket.close());
}

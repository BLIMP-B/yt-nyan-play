import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import Opus from '../apps/desktop/runtime/opus-codec.mjs';
import { PcmMixer, createDiscordAudioResource } from '../apps/desktop/runtime/voice-output.mjs';
import { VoiceMonitor } from '../apps/desktop/runtime/voice-monitor.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';

export async function verifyAudioNetwork() {
  const encoder = new Opus(), decoder = new Opus(), logs = [];
  const speaking = new EventEmitter(); speaking.users = new Map();
  const streams = new Map(), entry = { channelId: '33333', connection: { receiver: { speaking, subscribe(id) { const stream = new PassThrough({ objectMode: true }); streams.set(id, stream); return stream; } } } };
  const monitor = new VoiceMonitor(() => {}, () => {}, (_, message) => logs.push(message));
  const pcm = Buffer.alloc(3840);
  for (let i = 0; i < 960; i++) { const value = Math.round(8000 * Math.sin(i * Math.PI * 2 * 440 / 48000)); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2); }
  const mixer = new PcmMixer(), resource = createDiscordAudioResource(mixer);
  try {
    assert.equal(normalizeConfig().desktop.networkProfile, 'poor'); assert.equal(normalizeConfig().desktop.audioBitrateKbps, 48);
    const packets = [];
    for (let i = 0; i < 100; i++) {
      mixer.addMedia(Buffer.concat(Array(12).fill(pcm)));
      const packet = resource.playStream.read(); assert.ok(packet);
      packets.push(Buffer.from(packet)); assert.equal(packet.length, 120);
      const output = decoder.decode(packet); assert.equal(output.length, 3840);
    }
    // Switching a connected encoder applies the setting without restarting its clock.
    resource.metadata.configureNetwork('balanced'); assert.equal(resource.playStream.read().length, 240);
    resource.metadata.configureNetwork('poor', 64); assert.equal(resource.playStream.read().length, 160);
    resource.metadata.configureNetwork('poor', 48); assert.equal(resource.playStream.read().length, 120);
    encoder.encoderCTL(4006, 0); encoder.encoderCTL(4002, 48000);
    const packet = encoder.encode(pcm, 960);
    const longPacket = Buffer.concat([Buffer.from([(packet[0] & 252) | 3, 6]), ...Array(6).fill(packet.subarray(1))]);
    assert.equal(decoder.decode(longPacket).length, 23040);
    monitor.attach(entry, '11111', '99999'); clearInterval(monitor.timer);
    // Exercise the exact failure route: many live decoders, 120-ms packets,
    // speaking resubscriptions and delayed errors from retired streams.
    let recycledDecoders = 0;
    for (let round = 0; round < 20; round++) {
      for (let id = 0; id < 32; id++) {
        const key = String(44000 + id); speaking.emit('start', key);
        const stream = streams.get(key); stream.write(longPacket); stream.write(longPacket);
      }
      assert.ok(monitor.frame().some(byte => byte));
      for (const [id, user] of [...monitor.users]) {
        const retired = user.stream; user.ended = true; speaking.emit('start', id);
        retired.emit('error', new Error('late retired stream error'));
        assert.equal(monitor.users.get(id).stream, streams.get(id));
        streams.get(id).write(longPacket); monitor.remove(id); monitor.remove(id); recycledDecoders += 2;
      }
      assert.equal(monitor.users.size, 0); assert.ok(encoder.encode(pcm, 960).length);
    }
    const simulate = (profile, loss = true) => {
      monitor.stop(); monitor.attach(entry, '11111', '99999', profile); clearInterval(monitor.timer); speaking.emit('start', '44444');
      const arrivals = []; let previous = 0, dropped = 0;
      // Preserve RTP order, delay bursts by up to 180 ms and lose 1/11 packets.
      for (let i = 0; i < 300; i++) {
        if (loss && i % 11 === 5) { dropped++; continue; }
        previous = Math.max(previous, i + 5 + (i % 50 >= 20 && i % 50 < 28 ? 9 : 0));
        arrivals.push({ tick: previous, packet });
      }
      let silentFrames = 0, audibleFrames = 0, longestGap = 0, gap = 0, bufferedBytes = 0;
      for (let tick = 0; tick < 330; tick++) {
        while (arrivals[0]?.tick <= tick) streams.get('44444').write(arrivals.shift().packet);
        bufferedBytes = Math.max(bufferedBytes, monitor.users.get('44444')?.bytes.length || 0);
        const output = monitor.frame();
        if (tick < 30 || tick >= 290) continue;
        const audible = output.some(byte => byte);
        if (audible) { audibleFrames++; gap = 0; } else { silentFrames++; longestGap = Math.max(longestGap, ++gap); }
      }
      return { profile, droppedPackets: dropped, maximumJitterMs: 180, audibleFrames, silentFrames, longestGapMs: longestGap * 20, maximumBufferedMs: bufferedBytes / 192 };
    };
    const fast = simulate('fast', false), poor = simulate('poor', false), loss = simulate('poor');
    assert.ok(poor.silentFrames < fast.silentFrames, JSON.stringify({ poor, fast }));
    assert.ok(loss.audibleFrames > 230 && loss.maximumBufferedMs <= 1000);
    const transport = bitrate => {
      let tokens = 400, delivered = 0;
      const bytes = bitrate / 8 / 50 + 60; // UDP/RTP/encryption overhead allowance.
      for (let tick = 0; tick < 300; tick++) { tokens = Math.min(400, tokens + 200); if (tokens >= bytes) { tokens -= bytes; delivered++; } }
      return delivered;
    };
    assert.equal(transport(48000), 300); assert.ok(transport(128000) < 180);
    assert.equal(logs.length, 0, logs.join('\n'));
    return { passed: true, defaultProfile: 'poor', bitrate: 48000, customBitrate: 64000, cbrPacketBytes: 120, packets: packets.length, recycledDecoders, longPacketSamples: 5760, retiredErrorsIsolated: true, transport: { capacityKbps: 80, delivered: transport(48000), highBitrateDelivered: transport(128000), total: 300 }, profiles: { poor, fast }, loss };
  } finally { monitor.stop(); resource.playStream.destroy(); mixer.destroy(); encoder.delete(); decoder.delete(); decoder.delete(); }
}

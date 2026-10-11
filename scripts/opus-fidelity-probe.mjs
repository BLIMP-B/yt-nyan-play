import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { PcmMixer, createDiscordAudioResource } from '../apps/desktop/runtime/voice-output.mjs';
import Opus from '../apps/desktop/runtime/opus-codec.mjs';

function page(packet, sequence, granule, flags = 0) {
  const sizes = []; let remaining = packet.length;
  while (remaining >= 255) { sizes.push(255); remaining -= 255; }
  sizes.push(remaining);
  const header = Buffer.alloc(27 + sizes.length); header.write('OggS'); header[5] = flags;
  header.writeBigUInt64LE(BigInt(granule), 6); header.writeUInt32LE(1, 14); header.writeUInt32LE(sequence, 18);
  header[26] = sizes.length; header.set(sizes, 27);
  const bytes = Buffer.concat([header, packet]); let crc = 0;
  for (const byte of bytes) { crc ^= byte << 24; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc >>> 31) ? 0x04c11db7 : 0)) >>> 0; }
  bytes.writeUInt32LE(crc, 22); return bytes;
}
function decodeIndependently(packets) {
  const head = Buffer.alloc(19); head.write('OpusHead'); head[8] = 1; head[9] = 2; head.writeUInt16LE(312, 10); head.writeUInt32LE(48000, 12);
  const tags = Buffer.alloc(16); tags.write('OpusTags');
  const ogg = Buffer.concat([page(head, 0, 0, 2), page(tags, 1, 0), ...packets.map((p, i) => page(p, i + 2, (i + 1) * 960, i === packets.length - 1 ? 4 : 0))]);
  // FFmpeg's libopus decoder is independent of the application's WASM wrapper.
  return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-c:a', 'libopus', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { input: ogg, maxBuffer: 4 * 1024 * 1024 });
}
function tone(amplitude) {
  const pcm = Buffer.alloc(960 * 100 * 4);
  for (let i = 0; i < pcm.length / 4; i++) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin(i * 2 * Math.PI * 440 / 48000)), i * 4);
    pcm.writeInt16LE(Math.round(amplitude * Math.sin(i * 2 * Math.PI * 997 / 48000)), i * 4 + 2);
  }
  return pcm;
}
function fidelity(reference, decoded) {
  const channels = [];
  for (let channel = 0; channel < 2; channel++) {
    let xy = 0, xx = 0, yy = 0, squaredError = 0, count = 0;
    for (let sample = 1920; sample < Math.min(reference.length, decoded.length) / 4; sample++) {
      const x = reference.readInt16LE(sample * 4 + channel * 2), y = decoded.readInt16LE(sample * 4 + channel * 2);
      xy += x * y; xx += x * x; yy += y * y; squaredError += (y - x) ** 2; count++;
    }
    channels.push({ correlation: xy / Math.sqrt(xx * yy), normalizedError: Math.sqrt(squaredError / xx), rms: Math.sqrt(yy / count), samples: count });
  }
  return channels;
}
export async function verifyOpusFidelity({ includeLegacy = false } = {}) {
  const cases = [];
  for (const [profile, bitrateKbps, amplitude] of [['poor', 48, 10000], ['balanced', 96, 10000], ['fast', 128, 10000], ['poor', 48, 32]]) {
    const mixer = new PcmMixer(profile), resource = createDiscordAudioResource(mixer, profile, bitrateKbps), reference = tone(amplitude);
    try {
      const completed = mixer.addSpeech(reference, 1), packets = [];
      for (let i = 0; i < 100; i++) packets.push(resource.playStream.read());
      await completed;
      const decoded = decodeIndependently(packets), channels = fidelity(reference, decoded);
      cases.push({ profile, bitrateKbps, amplitude, encoding: resource.metadata.encoding, packetBytes: packets[0].length, channels,
        passed: channels.every(c => c.correlation >= .97 && c.normalizedError < .27 && c.samples > 90000) && packets.every(p => p.length === bitrateKbps * 2.5) });
    } finally { resource.playStream.destroy(); mixer.destroy(); }
  }
  let legacy = null;
  if (includeLegacy) {
    const encoder = new Opus(), reference = tone(10000), packets = [];
    try {
      for (const [ctl, value] of [[4002, 48000], [4006, 0], [4012, 1], [4014, 20], [4016, 0]]) encoder.encoderCTL(ctl, value);
      for (let i = 0; i < reference.length; i += 3840) packets.push(encoder.encode(reference.subarray(i, i + 3840), 960));
      legacy = { fec: true, expectedLossPercent: 20, channels: fidelity(reference, decodeIndependently(packets)) };
    } finally { encoder.delete(); }
  }
  return { passed: cases.every(c => c.passed), decoder: 'FFmpeg libopus', measuredAt: 'local-encode-decode', receiverDropoutsVerified: false, cases, legacy };
}

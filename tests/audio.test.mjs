import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { Voicevox, ZUNDAMON_STYLES } from '../apps/desktop/core/voicevox.mjs';
import { bouyomiSpeak } from '../apps/desktop/runtime/bouyomi.mjs';
import { PcmMixer, createDiscordAudioResource, decodeAudio, VoiceOutput } from '../apps/desktop/runtime/voice-output.mjs';
import { createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus } from '@discordjs/voice';
import OpusScript from '../apps/desktop/runtime/opus-codec.mjs';
const pcm = value => { const b = Buffer.alloc(3840); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i); return b; };
function wav() { const data = pcm(1000), b = Buffer.alloc(44); b.write('RIFF'); b.writeUInt32LE(36 + data.length, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data.length, 40); return Buffer.concat([b, data]); }
test('VOICEVOX discovers all Zundamon styles and uses audio_query then synthesis', async t => {
  const requests = []; const audio = wav(); const ids = [3, 1, 7, 5, 22, 38, 75, 76];
  const server = createServer(async (req, res) => { const chunks = []; for await (const c of req) chunks.push(c); requests.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString() });
    if (req.url === '/speakers') res.end(JSON.stringify([{ name: 'ずんだもん', styles: ZUNDAMON_STYLES.map((name, i) => ({ name, id: ids[i], type: 'talk' })) }])); else if (req.url.startsWith('/audio_query')) res.end('{}'); else res.end(audio);
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const api = new Voicevox(`http://127.0.0.1:${server.address().port}`); assert.equal((await api.validateZundamon()).available, true);
  for (const id of ids) assert.deepEqual(await api.synthesize('猫', { ...normalizeConfig().speech, styleId: id }), audio);
  assert.equal(requests.length, 17); assert.equal(requests[1].method, 'POST'); assert.equal(JSON.parse(requests[2].body).volumeScale, 1); assert.ok(requests[2].url.includes('speaker=3'));
});
test('missing styles and failed or invalid engine responses are detected', async () => {
  const api = new Voicevox('http://localhost', async () => new Response(JSON.stringify([{ name: 'ずんだもん', styles: [{ name: 'ノーマル', id: 3 }] }])));
  assert.equal((await api.validateZundamon()).missing.length, 7);
  await assert.rejects(new Voicevox('http://localhost', async () => new Response('', { status: 503 })).speakers(), /HTTP 503/);
  const broken = new Voicevox('http://localhost', async url => new Response(url.includes('audio_query') ? '{}' : 'invalid'));
  await assert.rejects(broken.synthesize('猫', normalizeConfig().speech), /WAV/);
});
test('mixer ducks media while speaking and restores volume, with clipping protection', async t => {
  const mixer = new PcmMixer(); t.after(() => mixer.destroy()); mixer.mediaVolume = 1; mixer.ducking = .25;
  mixer.addMedia(Buffer.concat(Array.from({ length: 12 }, () => pcm(10000)))); const done = mixer.addSpeech(pcm(20000), .5); assert.equal(mixer.takeFrame().readInt16LE(), 12500); await done;
  assert.equal(mixer.takeFrame().readInt16LE(), 10000);
  mixer.clearMedia(); mixer.addMedia(Buffer.concat(Array.from({ length: 12 }, () => pcm(30000)))); const clipped = mixer.addSpeech(pcm(30000), 1); mixer.ducking = 1; assert.equal(mixer.takeFrame().readInt16LE(), 32767); await clipped;
});
test('FFmpeg decodes WAV to 48kHz stereo PCM and rejects invalid audio', async () => {
  assert.deepEqual(await decodeAudio(wav()), pcm(1000)); await assert.rejects(decodeAudio(Buffer.from('broken')), /FFmpeg/);
});
test('real Discord audio encoder advances successive speech jobs and sends non-silent Opus', { timeout: 12000 }, async t => {
  const mixer = new PcmMixer(), player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } });
  t.after(() => { player.stop(true); mixer.destroy(); });
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO); t.after(() => decoder.delete());
  const packets = []; player._preparePacket = packet => packets.push(Buffer.from(packet));
  player.play(createDiscordAudioResource(mixer));
  for (let i = 0; i < 3; i++) await mixer.addSpeech(Buffer.concat(Array.from({ length: 15 }, () => pcm(1000 + i * 1000))), 1, AbortSignal.timeout(3000));
  assert.equal(player.state.status, AudioPlayerStatus.Playing);
  assert.ok(packets.length >= 30);
  assert.ok(packets.some(packet => decoder.decode(packet).some(byte => byte !== 0)), 'Opus must contain audible PCM');
});
test('an ended Discord stream rejects new speech immediately instead of freezing the queue', async t => {
  const mixer = new PcmMixer(), player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  t.after(() => { player.stop(true); mixer.destroy(); });
  const resource = createDiscordAudioResource(mixer); player.play(resource);
  await mixer.addSpeech(pcm(1000), 1);
  // An encoder underrun used to leave the VC marked ready with a destroyed mixer.
  resource.playStream.push(null);
  await once(player, AudioPlayerStatus.Idle); await new Promise(resolve => setImmediate(resolve));
  assert.equal(mixer.destroyed, true);
  await assert.rejects(mixer.addSpeech(pcm(1000), 1), /終了/);
});
test('classic Bouyomi TCP packet contains UTF-8 text and 15-byte header', async t => {
  let resolvePacket; const packet = new Promise(resolve => { resolvePacket = resolve; }); const server = createTcpServer(socket => { const chunks = []; socket.on('data', b => chunks.push(b)); socket.on('end', () => { resolvePacket(Buffer.concat(chunks)); socket.end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  await bouyomiSpeak('にゃん', { ...normalizeConfig().speech, bouyomiPort: server.address().port }); const b = await packet; assert.equal(b.readInt16LE(0), 1); assert.equal(b.readInt32LE(11), Buffer.byteLength('にゃん')); assert.equal(b.subarray(15).toString(), 'にゃん');
});
test('interrupting forwarded speech cancels only the selected Discord output', async () => {
  const output = new VoiceOutput(() => null, () => normalizeConfig(), () => {}), started = [], finish = new Map();
  let ready; const bothReady = new Promise(resolve => { ready = resolve; });
  output.connect = async guild => ({ mixer: { addSpeech: (_bytes, _volume, signal) => new Promise((resolve, reject) => {
    started.push(guild); finish.set(guild, resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (started.length === 2) ready();
  }) } });
  const a = output.speech('11111', wav(), 1), b = output.speech('22222', wav(), 1); await bothReady;
  output.interruptSpeech('11111'); await a; assert.equal(output.speechControllers.has('11111'), false); assert.equal(output.speechControllers.has('22222'), true);
  finish.get('22222')(); await b;
});
test('stop announcement bypasses held speech while normal speech waits for its output to resume', async () => {
  const output = new VoiceOutput(() => null, () => normalizeConfig(), () => {}), started = [];
  output.connect = async guild => { started.push(guild); return { mixer: { addSpeech: async () => {} } }; };
  output.holdSpeech('11111', true); const normal = output.speech('11111', wav(), 1);
  const priority = output.speech('11111', wav(), 1, undefined, 100); await priority;
  assert.deepEqual(started, ['11111']); output.holdSpeech('11111', false); await normal; assert.deepEqual(started, ['11111', '11111']);
});

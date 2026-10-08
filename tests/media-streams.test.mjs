import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { selectStream } from '../apps/desktop/core/media-streams.mjs';
import { openAudioStream } from '../apps/desktop/runtime/media-streams.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { PcmMixer } from '../apps/desktop/runtime/voice-output.mjs';

test('each service chooses audio-only first, then the smallest playable video with audio', () => {
  const sources = [
    ['https://youtu.be/jNQXAC9IVRw', 'rr.googlevideo.com'], ['https://www.nicovideo.jp/watch/sm9', 'delivery.domand.nicovideo.jp'],
    ['https://x.com/example/status/1', 'video.twimg.com'], ['https://instagram.com/reel/abc/', 'scontent.cdninstagram.com'],
    ['https://tiktok.com/@example/video/1', 'media.tiktokcdn.com'], ['https://facebook.com/watch/?v=1', 'video.fbcdn.net'],
    ['https://threads.net/@example/post/abc', 'video.cdninstagram.com'], ['https://bsky.app/profile/example/post/abc', 'video.bsky.app'],
    ['https://example.social/@user/123', 'example.social'],
  ];
  for (const [source, host] of sources) {
    const formats = [{ url: `https://${host}/large`, acodec: 'aac', vcodec: 'h264', height: 720 }, { url: `https://${host}/small`, acodec: 'aac', vcodec: 'h264', height: 144 }, { url: `https://${host}/audio`, acodec: 'opus', vcodec: 'none', abr: 48 }];
    assert.equal(selectStream({ formats, duration: 180 }, source).duration, 180);
    assert.equal(selectStream({ formats }, source).url, formats[2].url);
    assert.equal(selectStream({ formats: formats.slice(0,2) }, source).height, 144);
    assert.equal(selectStream({ formats: [{ ...formats[0], acodec: 'none' }] }, source), null);
    assert.equal(selectStream({ formats: [{ ...formats[2], has_drm: true }] }, source), null);
    assert.equal(selectStream({ formats: [{ ...formats[2], url: 'https://127.0.0.1/private' }] }, source), null);
    assert.equal(selectStream({ formats: [{ ...formats[2], url: 'https://' + host + '.fake.test/audio' }] }, source), null);
  }
});
test('only supported streams and valid HTTP headers are passed to the player', () => {
  const source = 'https://youtu.be/jNQXAC9IVRw', format = { url: 'https://rr.googlevideo.com/audio', acodec: 'opus', vcodec: 'none', http_headers: { Referer: 'https://youtube.com/', Cookie: 'session=value', Origin: 'bad\r\ninjected', 'X-Unknown': 'ignored' } };
  assert.deepEqual(selectStream({ formats: [format] }, source).headers, { Referer: 'https://youtube.com/', Cookie: 'session=value' });
  assert.equal(selectStream({ is_live: true, formats: [format] }, source), null);
  assert.equal(selectStream({ formats: [{ ...format, protocol: 'dash_segments' }] }, source), null);
});
test('the real FFmpeg stream produces decodable audio, honors its offset and closes at EOF', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nyan-stream-')); t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = join(directory, 'tone.ogg');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:a', 'libopus', file]);
  const controller = new AbortController(), stream = await openAudioStream({ url: file }, 0.5, 'direct', controller.signal); t.after(() => stream.close());
  const response = await fetch(stream.url, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
  const ogg = Buffer.from(await response.arrayBuffer()); assert.equal(ogg.subarray(0,4).toString(), 'OggS');
  const received = join(directory, 'received.ogg'); writeFileSync(received, ogg);
  const pcm = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', received, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
  assert.ok(pcm.length >= 192000 && pcm.length < 350000, 'The 0.5 second start offset was applied');
  assert.ok(pcm.some(value => value !== 0)); assert.equal(stream.error, null);
  assert.equal((await fetch(stream.url)).status, 404); controller.abort();
});
test('speech ducking fades down and back without changing the independent BGM gain', async t => {
  const c = normalizeConfig(); assert.equal(c.media.duckFadeOutMs, 3000); assert.equal(c.media.duckFadeInMs, 3000); assert.equal(c.hourly.bgmFadeInMs, 3000); assert.equal(c.hourly.bgmFadeOutMs, 3000);
  const mixer = new PcmMixer(); t.after(() => mixer.destroy()); mixer.ducking = 0.05; mixer.duckFadeOutMs = mixer.duckFadeInMs = 3000;
  const controller = new AbortController(); const speech = mixer.addSpeech(Buffer.alloc(3840*20), 1, controller.signal); speech.catch(() => {});
  mixer.takeFrame(10000); assert.equal(mixer.duckGain.value(10000), 1);
  mixer.takeFrame(11500); assert.equal(mixer.duckGain.value(11500), 0.525);
  mixer.takeFrame(13000); assert.ok(Math.abs(mixer.duckGain.value(13000)-0.05) < 1e-10);
  assert.equal(mixer.backgroundGain.value(13000), 1);
  controller.abort(); await assert.rejects(speech, { name: 'AbortError' }); mixer.takeFrame(13000);
  mixer.takeFrame(14500); assert.equal(mixer.duckGain.value(14500), 0.525);
  mixer.takeFrame(16000); assert.equal(mixer.duckGain.value(16000), 1);
  assert.equal(normalizeConfig({ media: { duckFadeOutMs: 0 }, hourly: { bgmFadeOutMs: 800 } }).hourly.bgmFadeOutMs, 800);
});
test('FFmpeg EOF is validated against the original duration instead of accepting a truncated input as a whole video', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nyan-short-stream-')); t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const file = join(directory, 'short.ogg'); execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:a', 'libopus', file]);
  const controller = new AbortController(), stream = await openAudioStream({ url: file, duration: 60 }, 0, 'full', controller.signal); t.after(() => stream.close());
  await (await fetch(stream.url)).arrayBuffer(); await stream.completion;
  assert.equal(stream.finished, true); assert.equal(stream.expectedSeconds, 60); assert.ok(stream.outputSeconds > 1.9 && stream.outputSeconds < 2.1);
  assert.match(stream.error, /終端より前/);
});

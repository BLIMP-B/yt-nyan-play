import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import ffmpeg from 'ffmpeg-static';
import { OggPrefetch } from '../apps/desktop/runtime/ogg-prefetch.mjs';
import { openAudioStream } from '../apps/desktop/runtime/media-streams.mjs';
const directory = mkdtempSync(join(tmpdir(), 'nyan-prefetch-'));
const generate = seconds => {
  const file = join(directory, seconds + '.ogg');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=660:duration=${seconds}`, '-c:a', 'libopus', '-page_duration', '20000', file]); return { file, bytes: readFileSync(file) };
};
const whole = generate(8), short = generate(2);
test.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
test('real Ogg samples prime before the browser opens, cap read-ahead and preserve every page across split headers', async () => {
  const prefetch = new OggPrefetch({ startupSeconds: 4, maxAheadSeconds: 6 }), output = [];
  let firstAt; prefetch.on('data', chunk => { firstAt ??= prefetch.seconds; output.push(chunk); });
  const chunks = []; for (let i = 0; i < whole.bytes.length; i += 113) chunks.push(whole.bytes.subarray(i, i + 113));
  Readable.from(chunks).pipe(prefetch); await prefetch.ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(firstAt >= 4 && prefetch.prefetchedSeconds >= 4); assert.ok(prefetch.seconds <= 6.001);
  assert.equal(prefetch.writableFinished, false); prefetch.setPosition(100); await finished(prefetch);
  assert.deepEqual(Buffer.concat(output), whole.bytes);
});
test('refilling never repeats headers or changes the encoded stream', async () => {
  const prefetch = new OggPrefetch({ startupSeconds: 1, maxAheadSeconds: 2 }), output = [];
  prefetch.on('data', chunk => output.push(chunk)); Readable.from([whole.bytes]).pipe(prefetch);
  await prefetch.ready; await new Promise(resolve => setImmediate(resolve));
  assert.equal(prefetch.refill(), true); assert.equal(prefetch.refill(), false); prefetch.setPosition(1);
  assert.equal(prefetch.holding, false); assert.equal(prefetch.refills, 1);
  prefetch.setPosition(100); await finished(prefetch); assert.deepEqual(Buffer.concat(output), whole.bytes);
});
test('short real streams reach EOF without waiting for four seconds of content', async t => {
  const controller = new AbortController(), stream = await openAudioStream({ url: short.file, duration: 2 }, 0, 'direct', controller.signal, 45, 6, 4); t.after(() => stream.close());
  assert.ok(stream.prefetchedSeconds >= 2 && stream.prefetchedSeconds < 2.1);
  const bytes = Buffer.from(await (await fetch(stream.url)).arrayBuffer()); await stream.completion;
  assert.equal(bytes.subarray(0,4).toString(), 'OggS'); assert.equal(stream.error, null);
});
test('stop during prefetch cancels the HTTP origin and never leaves a late stream running', async () => {
  let clientClosed = false; const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'audio/ogg' }); response.write(whole.bytes.subarray(0, 180)); response.on('close', () => { clientClosed = true; }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const controller = new AbortController(), requested = once(server, 'request');
    const stream = openAudioStream({ url: 'http://127.0.0.1:' + server.address().port, duration: 8 }, 0, 'direct', controller.signal, 45, 6, 4);
    await requested; controller.abort(); await assert.rejects(stream, { name: 'AbortError' });
    const until = Date.now() + 1000; while (!clientClosed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(clientClosed, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

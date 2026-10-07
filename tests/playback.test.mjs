import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { mediaScript } from '../apps/desktop/core/media-script.mjs';
import { mediaAnnouncement, parseMediaCommand } from '../apps/desktop/core/protocol.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { Store } from '../apps/desktop/core/store.mjs';
import { SpeechPool } from '../apps/desktop/core/speech-pool.mjs';
import { MediaPool } from '../apps/desktop/core/media-pool.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const temporary = t => { const p = mkdtempSync(join(tmpdir(), 'damare-playback-')); t.after(() => rmSync(p, { recursive: true, force: true })); return p; };
test('all playback modes preserve timestamps and legacy 無限 never repeats', () => {
  for (const [suffix, mode] of [['再生', 'preview'], ['無限', 'full'], ['直接', 'direct']]) {
    const command = parseMediaCommand(`https://youtu.be/abc?t=1m20s${suffix}`, normalizeConfig());
    assert.equal(command.mode, mode); assert.equal(command.startSeconds, 80); assert.notEqual(command.loop, true);
  }
  assert.equal(parseMediaCommand('https://www.nicovideo.jp/watch/sm1?from=35直接', normalizeConfig()).startSeconds, 35);
  assert.equal(parseMediaCommand('https://nico.ms/sm1再生', normalizeConfig()).mode, 'preview');
  assert.equal(parseMediaCommand('https://youtu.be/abc#t=15無限', normalizeConfig()).startSeconds, 15);
  const legacy = parseMediaCommand('NYANPLAY/1 ' + JSON.stringify({ version: 1, type: 'play', loop: true, mediaUrl: 'https://youtu.be/abc?t=15' }), normalizeConfig());
  assert.equal(legacy.mode, 'full'); assert.equal(legacy.startSeconds, 15);
});
test('announcements use URL service names including subdomains and shared links', () => {
  const expected = new Map([
    ['https://m.youtube.com/watch?v=a', 'ゆーちゅーぶ'], ['https://youtu.be/a', 'ゆーちゅーぶ'],
    ['https://www.nicovideo.jp/watch/sm1', 'にこにこどうが'], ['https://x.com/user/status/1', 'えっくす'],
    ['https://nico.ms/sm1', 'にこにこどうが'],
    ['https://twitter.com/user/status/1', 'ついったー'], ['https://www.instagram.com/reel/a', 'いんすたぐらむ'],
    ['https://vm.tiktok.com/a', 'てぃっくとっく'], ['https://fb.watch/a', 'ふぇいすぶっく'],
    ['https://www.threads.com/a', 'すれっず'], ['https://bsky.app/a', 'ぶるーすかい'],
    ['https://cdn.discordapp.com/a.mp3', 'でぃすこーどのメディア'], ['https://example.test/video', 'メディア'],
  ]);
  for (const [url, service] of expected) assert.equal(mediaAnnouncement(url), `${service}を再生します`);
});
function player(mode, startSeconds = 80) {
  const events = new Map(), timers = new Map(); let timerId = 0;
  const video = { tagName: 'VIDEO', paused: true, ended: false, currentTime: 0, duration: 300, readyState: 4, clientWidth: 500, clientHeight: 300, loop: true,
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, addEventListener(type, cb) { events.set(type, cb); }, removeEventListener(type, cb) { if (events.get(type) === cb) events.delete(type); } };
  const context = { document: { querySelectorAll: () => [video], querySelector: () => null }, window: {}, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id) };
  const read = (paused = false) => runInNewContext(mediaScript({ mode, startSeconds, paused }), context);
  return { video, read, context, fire: name => events.get(name)?.(), timers };
}
test('YouTube prerolls and midrolls do not seek to content offsets, finish a job, or consume preview time', () => {
  const p = player('preview'); let ad = true;
  p.context.window.ytInitialPlayerResponse = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'stale' } };
  p.context.document.querySelector = selector => selector === '#movie_player' ? { getPlayerResponse: () => ({ playabilityStatus: { status: 'OK' } }) } : selector === '#movie_player video' ? p.video : ad ? {} : null;
  p.video.currentTime = 60; p.video.ended = true;
  let state = p.read(); assert.equal(state.advertisement, true); assert.equal(state.ended, false); assert.equal(state.loginRequired, false); assert.equal(p.video.currentTime, 60); assert.equal(p.timers.size, 0);
  ad = false; p.video.ended = false; p.read(); assert.equal(p.video.currentTime, 80);
  p.video.currentTime = 100; p.fire('playing'); assert.equal(p.timers.size, 1);
  ad = true; p.video.currentTime = 999; p.fire('timeupdate'); assert.equal(p.timers.size, 0); assert.equal(p.read().previewFinished, false);
  ad = false; p.video.currentTime = 100; p.fire('timeupdate'); assert.equal(p.read().previewFinished, false); assert.equal(p.video.currentTime, 100);
  p.video.currentTime = 125; p.fire('timeupdate'); assert.equal(p.read().previewFinished, true);
});
test('45-second playback begins at URL offset, excludes buffering and pause, and cannot restart after its limit', () => {
  const p = player('preview'); p.read(); assert.equal(p.video.currentTime, 80); assert.equal(p.video.loop, false);
  p.fire('playing'); assert.equal(p.timers.size, 1);
  p.video.readyState = 1; p.fire('waiting'); assert.equal(p.timers.size, 0); assert.equal(p.read().previewFinished, false);
  p.video.readyState = 4; p.video.currentTime = 100; p.read(true); p.fire('pause'); assert.equal(p.timers.size, 0); assert.equal(p.read(true).previewFinished, false);
  p.read(false); p.fire('playing'); p.video.currentTime = 124.95; p.fire('timeupdate'); assert.equal(p.read().previewFinished, false);
  p.video.currentTime = 125; p.fire('timeupdate'); assert.equal(p.read().previewFinished, true); assert.equal(p.video.paused, true);
  p.read(false); assert.equal(p.video.paused, true);
});
test('無限 and 直接 play once to natural end without the 45-second cutoff', () => {
  for (const mode of ['full', 'direct']) {
    const p = player(mode); p.video.muted = true; p.read(); assert.equal(p.video.muted, false); p.video.currentTime = 200; assert.equal(p.read().previewFinished, false); assert.equal(p.video.loop, false);
    p.video.ended = true; p.video.paused = true; assert.equal(p.read().ended, true); assert.equal(p.video.paused, true);
  }
});
test('a previous preview timer is removed when full or direct controls reach the same media element', () => {
  for (const mode of ['full','direct']) {
    const p = player('preview', 0); p.read(); p.fire('playing'); assert.equal(p.timers.size, 1);
    runInNewContext(mediaScript({ mode, startSeconds: 0 }), p.context);
    assert.equal(p.timers.size, 0); assert.equal(p.video.__nyanBudget, undefined);
    p.video.currentTime = 60; const state = runInNewContext(mediaScript({ mode, startSeconds: 0 }), p.context);
    assert.equal(state.previewFinished, false); assert.equal(p.video.paused, false);
  }
});
test('end events remain complete after autoplay replaces the original media; YouTube state and duration endpoints also complete', () => {
  for (const mode of ['full', 'direct']) {
    const p = player(mode); p.read(); p.video.currentTime = 300; p.fire('ended');
    const next = { ...p.video, currentTime: 0, paused: false, ended: false }; p.context.document.querySelectorAll = () => [next];
    assert.equal(p.read().ended, true); assert.equal(next.paused, true);
    const api = player(mode); let state = 1; api.context.document.querySelector = s => s === '#movie_player' ? { getPlayerState: () => state } : null;
    api.read(); state = 0; assert.equal(api.read().ended, true);
    const endpoint = player(mode); endpoint.read(); endpoint.video.currentTime = 300; endpoint.video.paused = true;
    assert.equal(endpoint.read().ended, true); assert.equal(endpoint.video.paused, true);
    const paused = player(mode); paused.read(); paused.video.currentTime = 290; paused.video.paused = true;
    assert.equal(paused.read(true).ended, false, 'Pause and buffering are not completion');
  }
});
test('new media requests cancel old playback and pending requests in the same scope without restarting either', async t => {
  const store = new Store(temporary(t)), opened = [];
  const pool = new MediaPool(store, scope => ({ setPaused() {}, close() {}, play: (job, signal) => new Promise((resolve, reject) => { opened.push(job); job.finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }));
  const old = pool.enqueue({ guildId: '11111', mode: 'full' }); await tick();
  const waiting = pool.enqueue({ guildId: '11111', mode: 'preview' });
  const other = pool.enqueue({ guildId: '22222', mode: 'direct' }); await tick();
  const latest = pool.enqueue({ guildId: '11111', mode: 'direct' }, { interrupt: true }); await tick();
  assert.equal(old.status, 'cancelled'); assert.equal(waiting.status, 'cancelled'); assert.equal(latest.status, 'running'); assert.equal(other.status, 'running');
  assert.deepEqual(opened.map(j => j.id), [old.id, other.id, latest.id]);
  latest.finish(); other.finish(); await tick(); assert.equal(latest.status, 'completed'); assert.equal(other.status, 'completed');
  pool.close();
});
test('browser fallback requests the lowest exposed YouTube quality without muting or hiding playback', () => {
  const p = player('direct'); const requests = [];
  p.context.document.querySelector = selector => selector === '#movie_player' ? { getAvailableQualityLevels: () => ['hd1080', 'small', 'medium', 'tiny'], setPlaybackQualityRange: (...levels) => requests.push(levels), setPlaybackQuality() {} } : null;
  const state = runInNewContext(mediaScript({ mode: 'direct', bandwidthSaving: true }), p.context);
  assert.equal(state.lowestQuality, true); assert.deepEqual(requests, [['tiny','tiny']]); assert.equal(p.video.muted, false);
});
test('stop speech preempts its server even while paused and preserves waiting speech and other server', async t => {
  const store = new Store(temporary(t)), started = [];
  const pool = new SpeechPool(store, (job, signal) => new Promise((resolve, reject) => { started.push(job.payload.text); job.finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const active = pool.enqueue({ guildId: '11111', text: 'a' }); const waiting = pool.enqueue({ guildId: '11111', text: 'waiting' }); const other = pool.enqueue({ guildId: '22222', text: 'b' });
  pool.pauseGuild('11111', true);
  const stop = pool.speak({ guildId: '11111', text: 'さいせいをていししました', priority: 100 }, { interrupt: true });
  await tick(); assert.deepEqual(started, ['a', 'b', 'さいせいをていししました']); assert.equal(active.status, 'cancelled'); assert.equal(waiting.status, 'waiting'); assert.equal(other.status, 'running');
  store.jobs.find(j => j.payload.priority === 100).finish(); await stop; await tick(); assert.equal(waiting.status, 'waiting');
  pool.pauseGuild('11111', false); assert.equal(waiting.status, 'running'); waiting.finish(); other.finish(); await tick();
});
test('media waits for service announcement and stopping during it cannot open a playback window', async t => {
  const store = new Store(temporary(t)), opened = [], announce = new SpeechPool(store, (job, signal) => new Promise((resolve, reject) => { job.finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const media = new MediaPool(store, scope => ({ setPaused() {}, close() {}, play: async () => opened.push(scope) }), async (job, signal) => {
    if (job.payload.mode !== 'direct') await announce.speak({ guildId: job.payload.guildId, text: mediaAnnouncement(job.payload.url), priority: 50 }, { signal });
  });
  const cancelled = media.enqueue({ guildId: '11111', url: 'https://youtu.be/a', mode: 'preview' }); await tick(); assert.deepEqual(opened, []);
  media.clear('11111'); await tick(); assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(opened, []);
  const completed = media.enqueue({ guildId: '11111', url: 'https://www.nicovideo.jp/watch/sm1', mode: 'full' }); await tick();
  const speech = announce.activeJobs[0]; assert.equal(speech.payload.text, 'にこにこどうがを再生します'); speech.finish(); await tick(); assert.equal(completed.status, 'completed');
  media.enqueue({ guildId: '22222', url: 'https://x.com/a', mode: 'direct' }); await tick(); assert.deepEqual(opened, ['11111', '22222']);
  media.close();
});
test('stop announcement has reserved capacity even when ordinary waiting speech reaches its limit', t => {
  const store = new Store(temporary(t)); store.jobs = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), kind: 'speech', payload: { guildId: '11111' }, status: 'waiting' }));
  assert.throws(() => store.enqueue('speech', { guildId: '11111', text: '普通' }), /上限/);
  assert.equal(store.enqueue('speech', { guildId: '11111', text: 'さいせいをていししました', priority: 100 }).status, 'waiting');
});
test('Bot shutdown prevents priority speech from starting and cancels pending announcements', async t => {
  const store = new Store(temporary(t)), started = []; const pool = new SpeechPool(store, async j => started.push(j.payload.text));
  pool.halt(true); const ordinary = pool.enqueue({ text: '普通' }); await assert.rejects(pool.speak({ text: '停止告知', priority: 100 }), { name: 'AbortError' });
  await tick(); assert.deepEqual(started, []); assert.equal(ordinary.status, 'waiting'); pool.halt(false); await tick(); assert.deepEqual(started, ['普通']);
});

test('FFmpeg audio streams already have their offset applied and never seek a single-use HTTP stream back to zero', () => {
  for (const mode of ['preview', 'full', 'direct']) {
    const p = player(mode, 0); let seeks = 0;
    Object.defineProperty(p.video, 'currentTime', { get: () => 0.25, set() { seeks++; throw new Error('An unseekable stream would request its URL again'); } });
    const state = runInNewContext(mediaScript({ mode, startSeconds: 0, seek: false }), p.context);
    assert.equal(seeks, 0); assert.equal(p.context.window.__nyanStarted, true); assert.equal(state.currentTime, 0.25); assert.equal(p.video.paused, false);
  }
  const browser = player('full', 80); browser.read(); assert.equal(browser.video.currentTime, 80);
});

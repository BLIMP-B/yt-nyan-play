import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { parseRepository, playImages, extractZip, verifyChecksum, avdName, shellQuote } from '../apps/desktop/core/android-packages.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { protectedReadable, tweetSpeech, XApi } from '../apps/desktop/core/twitter.mjs';
import { TwitterSource } from '../apps/desktop/runtime/twitter.mjs';
import { AndroidRuntime } from '../apps/desktop/runtime/android.mjs';
import { BouyomiImport } from '../apps/desktop/runtime/bouyomi-import.mjs';
import { speechTargets, shouldRead, prepareSpeech } from '../apps/desktop/core/text.mjs';
import { MediaPool } from '../apps/desktop/core/media-pool.mjs';
import { Store } from '../apps/desktop/core/store.mjs';
const temporary = t => { const p = mkdtempSync(join(tmpdir(), 'damare-test-')); t.after(() => rmSync(p, { recursive: true, force: true })); return p; };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('Android catalog excludes previews and non-Play images, deduplicates latest stable revision', () => {
  const xml = '<sdk-sys-img><license id="android-sdk-license">terms &amp; conditions</license>' + [[35, 2, 'android-sdk-license'], [35, 5, 'android-sdk-license'], [36, 1, 'android-sdk-preview-license']].map(([api, rev, license]) => `<remotePackage path="system-images;android-${api};google_apis_playstore;x86_64"><type-details><api-level>${api}</api-level></type-details><revision><major>${rev}</major></revision><display-name>Google Play</display-name><uses-license ref="${license}"/></remotePackage>`).join('') + '</sdk-sys-img>';
  const r = parseRepository(xml); const images = playImages(r); assert.equal(images.length, 1); assert.equal(images[0].revision, '5.0.0'); assert.equal(r.licenses['android-sdk-license'], 'terms & conditions'); assert.throws(() => parseRepository('<!DOCTYPE foo><sdk-sys-img/>'));
});
test('Android archives enforce destination and checksums; API changes preserve separate devices', t => {
  const p = temporary(t); extractZip(zipSync({ 'cmdline-tools/bin/test.txt': Buffer.from('sdk') }), p, 'cmdline-tools/'); assert.equal(readFileSync(join(p, 'bin/test.txt'), 'utf8'), 'sdk');
  assert.throws(() => extractZip(zipSync({ '../escape': Buffer.from('bad') }), p)); assert.throws(() => verifyChecksum(Buffer.from('altered'), '0'.repeat(64)));
  const c = normalizeConfig().android; assert.equal(avdName(c), 'nyantalk_play_api35'); c.image = 'system-images;android-36;google_apis_playstore;x86_64'; assert.equal(avdName(c), 'nyantalk_play_api36'); assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
test('Bouyomi ZIP import preserves settings and dictionary bytes and backs up the previous import', t => {
  const folder = temporary(t), file = join(folder, 'original.zip'), dictionary = Buffer.from('\uFEFF1\tN\t猫\tねこ\r\n'), settings = Buffer.from('<Settings><PrvVersion>Beta21</PrvVersion><PortNumber>50001</PortNumber><PortNumberHttp>50080</PortNumberHttp><BroadcasterMode>false</BroadcasterMode><TagEnable>true</TagEnable><Speed>139</Speed></Settings>');
  writeFileSync(file, zipSync({ 'BouyomiChan.exe': Buffer.from('fixture'), 'BouyomiChan.setting': settings, 'ReplaceStudy.dic': dictionary }));
  const runtime = new BouyomiImport(folder); const imported = runtime.import(file); assert.equal(imported.speed, 139); assert.equal(imported.broadcasterMode, false);
  assert.deepEqual(readFileSync(join(runtime.directory, 'ReplaceStudy.dic')), dictionary); assert.deepEqual(readFileSync(join(runtime.directory, 'BouyomiChan.setting')), settings);
  runtime.import(file); assert.equal(readdirSync(folder).filter(n => n.startsWith('bouyomi.backup-')).length, 1);
});
test('Bouyomi native mode keeps raw education and tags for the original dictionary processor', () => {
  const c = normalizeConfig({ speech: { provider: 'bouyomi', readNames: false } });
  const text = '教育(abc_def=ねこ) (Study raw=word) **文字**'; assert.equal(prepareSpeech({ content: text }, c), text);
});
test('Twitter requires exact owner for protected accounts and skips textless media including RT', () => {
  const account = { id: '1', protected: true }; assert.equal(protectedReadable(account, null), false); assert.equal(protectedReadable(account, { id: '2' }), false); assert.equal(protectedReadable(account, { id: '1' }), true);
  assert.equal(tweetSpeech({ text: 'https://t.co/image', attachments: { media_keys: ['a'] } }), '');
  const rt = { referenced_tweets: [{ type: 'retweeted', id: '2' }] }; const includes = { tweets: [{ id: '2', text: '猫の写真 https://t.co/image', author_id: '3' }], users: [{ id: '3', name: 'ねこ' }] };
  assert.equal(tweetSpeech(rt, includes, { readRetweets: true }), 'リポスト、ねこ。猫の写真'); assert.equal(tweetSpeech(rt, includes, { readRetweets: false }), ''); includes.tweets[0].text = 'https://t.co/image'; assert.equal(tweetSpeech(rt, includes, { readRetweets: true }), '');
});
test('Twitter API pagination requests retain cursor and authentication without expanding media to speech', async () => {
  let requested; const api = new XApi(async (url, options) => { requested = { url, options }; return new Response('{}'); }); await api.tweets('123', '10', 'token', false, 'next'); assert.match(requested.url, /since_id=10/); assert.match(requested.url, /pagination_token=next/); assert.match(requested.url, /exclude=replies/); assert.equal(requested.options.headers.Authorization, 'Bearer token');
});
test('Twitter polling never requests protected timelines of other users', async t => {
  const c = normalizeConfig({ twitter: { accounts: ['private', 'public'], readExisting: true } }); const vault = { hasToken: () => false, read: () => 'app-token', clear() {} }, calls = [], read = [];
  const source = new TwitterSource(temporary(t), () => c, vault, vault, { speech: p => read.push(p), log() {}, logout() {} });
  source.api.user = async username => ({ data: { id: username === 'private' ? '1' : '2', protected: username === 'private', name: username } }); source.api.tweets = async id => { calls.push(id); return { data: [{ id: '12', text: 'こんにちは' }, { id: '13', text: 'https://t.co/media' }], meta: {} }; };
  source.running = true; await source.poll(); source.stop(); assert.deepEqual(calls, ['2']); assert.equal(read.length, 1); assert.equal(read[0].privateOwnerId, '');
});
test('logout during an OAuth refresh cannot restore the previous login', async t => {
  let finish; const writes = [], vault = { hasToken: () => false, save: value => writes.push(value), clear() {} };
  const source = new TwitterSource(temporary(t), () => normalizeConfig(), vault, vault, { logout() {}, log() {} });
  source.auth = { owner: { id: '1' }, accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 };
  source.tokenRequest = () => new Promise(resolve => { finish = resolve; });
  const pending = source.userSession(); source.logout(); finish({ access_token: 'new', expires_in: 300 });
  assert.equal(await pending, null); assert.equal(source.owner(), null); assert.deepEqual(writes, []);
});
test('Android refresh binds displayed license terms to the selected image', async t => {
  const config = normalizeConfig(), tools = '<sdk-repository><license id="android-sdk-license">tools terms</license><remotePackage path="cmdline-tools;latest"><uses-license ref="android-sdk-license"/><archives><archive><host-os>windows</host-os><complete><url>tools.zip</url><checksum>' + 'a'.repeat(40) + '</checksum></complete></archive></archives></remotePackage></sdk-repository>';
  const play = '<sdk-sys-img><license id="android-sdk-license">image terms</license><remotePackage path="system-images;android-35;google_apis_playstore;x86_64"><type-details><api-level>35</api-level></type-details><uses-license ref="android-sdk-license"/></remotePackage></sdk-sys-img>';
  const runtime = new AndroidRuntime(temporary(t), () => config, () => {}, async url => new Response(url.includes('sys-img') ? play : tools));
  const state = await runtime.refresh(); assert.equal(state.licenseImage, config.android.image); assert.deepEqual(state.licenses.map(l => l.text), ['tools terms', 'image terms']);
  config.android.image = 'system-images;android-36;google_apis_playstore;x86_64'; await assert.rejects(runtime.refresh(), /利用規約/);
});
test('forwarding is directional, deduplicated and does not recurse or echo through cycles', () => {
  const routes = [{ fromGuildId: '1', toGuildId: '2', mode: 'one-way' }, { fromGuildId: '2', toGuildId: '3', mode: 'two-way' }, { fromGuildId: '1', toGuildId: '4', mode: 'none' }]; assert.deepEqual(speechTargets('1', routes), ['1', '2']); assert.deepEqual(speechTargets('3', routes), ['3', '2']);
});
test('disabled read channel still has persisted routing; master is independently accepted', () => {
  const c = normalizeConfig({ bot: { masterTextChannelId: '99999', bindings: [{ guildId: '11111', textChannelIds: ['22222'], voiceChannelId: '33333', disabledTextChannelIds: ['22222'] }] } }); const m = { guildId: '11111', channelId: '22222', userId: '44444', content: '猫' }; assert.equal(shouldRead(m, c), false); m.channelId = '99999'; assert.equal(shouldRead(m, c), true);
});
test('server media plays independently while master suspends and then resumes both', async t => {
  const store = new Store(temporary(t)), browsers = new Map(); const pool = new MediaPool(store, scope => { const browser = { paused: false, status: {}, setPaused(value) { this.paused = value; }, setDucked() {}, show() {}, close() {}, play: (_job, signal) => new Promise((resolve, reject) => { browser.finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }; browsers.set(scope, browser); return browser; });
  const a = pool.enqueue({ guildId: '11111' }), b = pool.enqueue({ guildId: '22222' }); assert.equal(a.status, 'running'); assert.equal(b.status, 'running');
  const master = pool.enqueue({ master: true, guildId: '33333' }); assert.equal(master.status, 'running'); assert.equal(browsers.get('11111').paused, true); assert.equal(browsers.get('22222').paused, true);
  browsers.get('master').finish(); await tick(); assert.equal(browsers.get('11111').paused, false); assert.equal(browsers.get('22222').paused, false);
  pool.clear('11111'); await tick(); assert.equal(a.status, 'cancelled'); assert.equal(b.status, 'running'); browsers.get('22222').finish(); await tick(); assert.equal(b.status, 'completed'); pool.close();
});
test('cancelling a paused master queue lets waiting guild media start', async t => {
  const store = new Store(temporary(t)); const pool = new MediaPool(store, () => ({ setPaused() {}, close() {}, play: (_job, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }));
  pool.pause(true, 'master'); const master = pool.enqueue({ master: true }); const guild = pool.enqueue({ guildId: '11111' });
  assert.equal(master.status, 'waiting'); assert.equal(guild.status, 'waiting');
  pool.clear('master'); await tick(); assert.equal(master.status, 'cancelled'); assert.equal(guild.status, 'running');
  pool.close(); await tick();
});

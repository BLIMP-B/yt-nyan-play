import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AndroidNotifications } from '../apps/desktop/runtime/android-notifications.mjs';
import { parseAndroidNotification, androidEnvironmentChanged } from '../apps/desktop/core/android-notifications.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { outputTargets } from '../apps/desktop/core/destination.mjs';

// AOSP Android 15 NotificationRecord.dump: primary extras are indented by 4+4.
const dump = (body, flags = 'AUTO_CANCEL') => `NotificationRecord(pkg=com.example uid=10123)
  flags=${flags}
  notification=
    tickerText=null
    extras={
        android.title=String (受信)
        android.text=String (省略本文)
        android.bigText=SpannableString (${body})
    }
  publicNotification=
    extras={
        android.title=String (ロック画面)
        android.text=String (内容を非表示)
    }
  stats=NotificationStats
`;

test('native notification dump reads expanded multiline text and ignores the lock-screen substitute and persistent summaries', () => {
  assert.deepEqual(parseAndroidNotification(dump('本文 (かっこ)\n2行目')), { title: '受信', body: '本文 (かっこ)\n2行目', text: '受信。本文 (かっこ)\n2行目' });
  for (const flags of ['ONGOING_EVENT|NO_CLEAR', 'GROUP_SUMMARY|AUTO_CANCEL', '0x200', '2']) assert.equal(parseAndroidNotification(dump('skip', flags)), null);
  assert.equal(parseAndroidNotification('error: no active notification matching key'), null);
  assert.equal(parseAndroidNotification(dump('a'.repeat(70000))), null);
  const inbox = dump('unused').replace(/        android\.(?:text|bigText)=.*\n/g, '');
  const withLines = inbox.replace('    }', '        android.textLines=CharSequence[] (2)\n          [0] 一行目\n          [1] 二行目\n    }');
  assert.equal(parseAndroidNotification(withLines).text, '受信。一行目。二行目');
});

function fixture() {
  const config = normalizeConfig(); const records = new Map(), calls = [], spoken = [];
  const android = new EventEmitter(); android.status = 'running'; let cancelCount = 0;
  android.adb = async (args, options) => {
    options.signal.throwIfAborted(); calls.push({ args, options });
    if (args[1] === 'cmd notification list') return [...records.keys()].join('\n');
    const match = /get '(.*)'$/.exec(args[1]); assert.ok(match, 'ADB key must be quoted, pipes must not execute'); return records.get(match[1]) || '';
  };
  const reader = new AndroidNotifications(android, () => config, { speech: p => spoken.push(p), cancel: () => cancelCount++, log: () => {} }, { automatic: false });
  return { config, records, calls, spoken, android, reader, get cancelCount() { return cancelCount; } };
}

test('notifications skip the initial baseline, read new/changed messages once and route selectable PC/all-VC/both output', async () => {
  const f = fixture(); const old = '0|com.example|1|old|10123', fresh = '0|com.example|2|new|10123';
  f.records.set(old, dump('既存')); await f.reader.poll(); await f.reader.poll(); assert.equal(f.spoken.length, 0);
  f.records.set(fresh, dump('新規')); await f.reader.poll(); await f.reader.poll(); assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].text, '受信。新規'); assert.equal(f.spoken[0].output, 'both'); assert.equal(f.spoken[0].master, true); assert.equal(f.spoken[0].system, true);
  f.config.android.notificationOutput = 'local'; f.records.set(fresh, dump('更新')); await f.reader.poll(); assert.equal(f.spoken[1].output, 'local');
  f.config.android.notificationOutput = 'discord'; f.records.set(fresh, dump('再更新')); await f.reader.poll(); assert.equal(f.spoken[2].output, 'discord');
  const connections = [{ guildId: '11111', status: 'ready' }, { guildId: '22222', status: 'ready' }];
  assert.deepEqual(outputTargets('both', connections.map(v => v.guildId), connections), ['11111', '22222']);
  assert.deepEqual(outputTargets('both', [], []), []); assert.deepEqual(outputTargets('local', ['11111'], connections), []);
  f.records.delete(fresh); await f.reader.poll(); f.records.set(fresh, dump('再登場')); await f.reader.poll(); assert.equal(f.spoken.length, 4);
  f.reader.close();
});

test('polling bounds work and rotates through unchanged keys without starving updates; disabled/booting readers do no ADB work', async () => {
  const f = fixture(); for (let i = 0; i < 100; i++) f.records.set(`0|com.example|${i}|tag|10123`, dump(`本文${i}`));
  await f.reader.poll(); await f.reader.poll(); assert.equal(f.calls.filter(c => c.args[1].startsWith('cmd notification get')).length, 8);
  for (let i = 0; i < 12; i++) await f.reader.poll(); assert.equal(f.spoken.length, 0);
  f.records.set('0|com.example|99|tag|10123', dump('最後の通知を更新'));
  for (let i = 0; i < 13; i++) await f.reader.poll(); assert.equal(f.spoken.length, 1);
  assert.ok(f.calls.every(c => c.options.timeout <= 3000 && c.options.maxOutputBytes <= 65536));
  const count = f.calls.length; f.android.bootController = new AbortController(); await f.reader.poll(); assert.equal(f.calls.length, count);
  f.android.bootController = null; f.config.android.readNotifications = false; f.reader.update(); await f.reader.poll(); assert.equal(f.calls.length, count); assert.equal(f.cancelCount, 1);
  f.reader.close();
});

test('stop/disable aborts pending reads and late old-VM responses cannot speak', async () => {
  const f = fixture(); await f.reader.poll(); let release;
  f.android.adb = () => new Promise(resolve => { release = resolve; }); const pending = f.reader.poll();
  f.android.status = 'stopped'; f.android.emit('change'); release('0|com.example|1|new|10123'); await pending;
  assert.equal(f.spoken.length, 0); assert.equal(f.reader.error, ''); assert.equal(f.reader.baselined, false); f.reader.close();
});

test('an oversized or vanished notification does not block subsequent notification updates', async () => {
  const f = fixture(); const good = '0|com.example|2|good|10123', bad = '0|com.example|1|bad|10123';
  f.records.set(good, dump('初期')); f.records.set(bad, dump('初期')); await f.reader.poll(); await f.reader.poll();
  const adb = f.android.adb; f.android.adb = (args, options) => args[1].includes('|bad|') ? Promise.reject(new Error('Androidの応答が大きすぎます')) : adb(args, options);
  f.records.set(good, dump('更新')); await f.reader.poll();
  assert.equal(f.spoken.length, 1); assert.equal(f.spoken[0].text, '受信。更新'); assert.match(f.reader.error, /大きすぎ/); f.reader.close();
});

test('notification preferences are validated and can change without rebuilding or stopping the VM', () => {
  const before = normalizeConfig().android;
  const after = normalizeConfig({ android: { notificationOutput: 'local', readNotifications: false } }).android;
  assert.equal(androidEnvironmentChanged(before, after), false);
  assert.equal(androidEnvironmentChanged(before, { ...after, ramMb: 4096 }), true);
  assert.throws(() => normalizeConfig({ android: { notificationOutput: 'arbitrary' } }));
});

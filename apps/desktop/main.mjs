import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification, powerMonitor, net } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Store } from './core/store.mjs';
import { normalizeConfig } from './core/config.mjs';
import { RE2 } from 're2-wasm';
import { JobRunner } from './core/queue.mjs';
import { Voicevox } from './core/voicevox.mjs';
import { parseMediaCommand } from './core/protocol.mjs';
import { DiscordBot } from './runtime/bot.mjs';
import { VoiceOutput } from './runtime/voice-output.mjs';
import { MediaBrowser } from './runtime/media-browser.mjs';
import { Vault } from './runtime/vault.mjs';
import { EngineProcess } from './runtime/engine-process.mjs';
import { BouyomiImport } from './runtime/bouyomi-import.mjs';
import { bouyomiSpeak } from './runtime/bouyomi.mjs';
import { AndroidRuntime } from './runtime/android.mjs';
import { TwitterSource } from './runtime/twitter.mjs';
import { MediaPool } from './core/media-pool.mjs';
import { speechTargets } from './core/text.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');
app.setName('にゃんとーく〜Damare〜');
app.setPath('userData', join(app.getPath('appData'), 'nyan-talk-damare'));
if (process.env.NYAN_DATA_DIR) app.setPath('userData', process.env.NYAN_DATA_DIR);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window, tray, store, vault, bot, voice, media, speechRunner, engine, android, twitter, twitterAppVault, bouyomi;
  let quitting = false; let stateTimer; let notificationAt = 0; let notifiedEntry; const pendingAudio = new Map(); const captures = new Map(); let captureRequest = null; let captureChain = Promise.resolve();
  const getConfig = () => store.config;
  const emitState = () => {
    if (stateTimer || !window || window.isDestroyed()) return;
    stateTimer = setTimeout(() => { stateTimer = null; if (!window.isDestroyed()) window.webContents.send('nyan:state', snapshot()); }, 80);
  };
  const snapshot = () => ({ version: app.getVersion(), config: store.exportConfig(), tokenSaved: vault.hasToken(), vaultAvailable: vault.available(),
    bot: { status: bot.status, name: bot.client?.user?.username || '', startedAt: bot.startedAt, servers: bot.catalog() },
    voices: voice.snapshot(), jobs: structuredClone(store.jobs).reverse(), logs: store.logs,
    paused: { speech: speechRunner.paused, media: media.paused }, media: media.status, engineRunning: Boolean(engine.child), android: android.snapshot(), twitter: twitter.snapshot(), bouyomi: bouyomi.snapshot() });
  const audioCommand = (type, data, signal, timeout = 180000) => new Promise((resolve, reject) => {
    signal?.throwIfAborted(); const id = data.id || crypto.randomUUID();
    const timer = setTimeout(() => finish(new Error('音声処理がタイムアウトしました')), timeout);
    const abort = () => { window?.webContents.send('nyan:audio', { type: 'cancel', id }); finish(new DOMException('Cancelled', 'AbortError')); };
    const finish = error => { if (!pendingAudio.has(id)) return; pendingAudio.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    pendingAudio.set(id, finish); signal?.addEventListener('abort', abort, { once: true });
    if (type === 'capture:start') window.webContents.executeJavaScript(`window.nyanCapture(${JSON.stringify({ type, id })})`, true).catch(finish);
    else window.webContents.send('nyan:audio', { ...data, type, id });
  });
  const control = (name, guildId) => {
    if (name === 'pause' || name === 'resume') { const paused = name === 'pause'; if (guildId) speechRunner.pauseGuild(guildId, paused); else speechRunner.pause(paused); media.pause(paused, guildId); }
    if (name === 'skip') media.skip(guildId);
    if (name === 'stop') { speechRunner.clear(guildId); media.clear(guildId); }
  };
  async function startBot() {
    if (bot.status !== 'offline') return;
    if (getConfig().speech.engineExecutable && !engine.child) engine.start(getConfig().speech.engineExecutable, getConfig().speech.engineUrl);
    await bot.start(vault.read());
    speechRunner.pause(false); media.pause(false); media.drain();
  }
  function stopBot() { speechRunner.pause(true); media.pause(true); speechRunner.skip(); media.skip(); bot.stop(); }
  async function action(name, data) {
    if (name === 'state') return snapshot();
    if (name === 'config:save') {
      const c = normalizeConfig(data);
      if ((android.child || android.busy) && JSON.stringify(c.android) !== JSON.stringify(store.config.android)) throw new Error('Androidの停止後に仮想環境の設定を変更してください');
      for (const d of c.dictionary) if (d.regex) new RE2(d.source, d.caseSensitive ? 'gu' : 'giu');
      store.updateConfig(c); if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: c.desktop.autoStart, args: c.desktop.startMinimized ? ['--minimized'] : [] });
      return snapshot();
    }
    if (name === 'token:save') { vault.save(data); return { saved: true }; }
    if (name === 'token:clear') { stopBot(); vault.clear(); return { saved: false }; }
    if (name === 'bot:start') { await startBot(); return snapshot(); }
    if (name === 'bot:stop') { stopBot(); return snapshot(); }
    if (name === 'voice:join') { await voice.connect(String(data)); return snapshot(); }
    if (name === 'voice:leave') { voice.disconnect(String(data)); return snapshot(); }
    if (name === 'voices:list') return new Voicevox(getConfig().speech.engineUrl).speakers();
    if (name === 'voices:check') {
      const engineApi = new Voicevox(getConfig().speech.engineUrl); const result = await engineApi.validateZundamon();
      if (!result.available) throw new Error(`エンジンに不足しているずんだもんの声種: ${result.missing.join('、')}`);
      if (data?.synthesize) for (const style of result.styles) await engineApi.synthesize('ずんだもんの音声テストなのだ。', { ...getConfig().speech, styleId: style.id });
      return result;
    }
    if (name === 'engine:start') { engine.start(getConfig().speech.engineExecutable, getConfig().speech.engineUrl); return snapshot(); }
    if (name === 'engine:stop') { engine.stop(); return snapshot(); }
    if (name === 'engine:choose') { const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '実行ファイル', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }] }); return result.filePaths[0] || ''; }
    if (name === 'clip:choose') { const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '音声', extensions: ['wav', 'mp3', 'ogg', 'flac'] }] }); return result.filePaths[0] || ''; }
    if (name === 'speech:test') {
      if (typeof data?.text !== 'string' || !data.text.trim() || data.text.length > 2000) throw new Error('読み上げる文章を入力してください');
      const job = store.enqueue('speech', { text: data.text, guildId: String(data.guildId || ''), userId: '', styleId: Number(data.styleId ?? getConfig().speech.styleId) }); void speechRunner.drain(); return job;
    }
    if (name === 'media:add') {
      const command = parseMediaCommand(`${String(data?.url || '')}${data?.loop ? '無限' : '再生'}`, getConfig());
      if (!command) throw new Error('再生URLを入力してください');
      return media.enqueue({ ...command, master: data?.master === true, guildId: String(data.guildId || ''), startSeconds: Math.max(0, Math.min(86400, Number(data.startSeconds) || command.startSeconds)), title: command.title });
    }
    if (name === 'control') { if (!['pause', 'resume', 'skip', 'stop'].includes(data)) throw new Error('未対応の操作です'); control(data); return snapshot(); }
    if (name === 'media:show') { media.show(); return null; }
    if (name === 'job:action') {
      const job = store.jobs.find(j => j.id === data?.id); if (!job) throw new Error('項目が見つかりません');
      const runner = job.kind === 'speech' ? speechRunner : media.forJob(job);
      if (data.action === 'retry') runner.retry(job.id); else if (data.action === 'cancel') runner.cancel(job.id); else throw new Error('未対応の操作です'); return snapshot();
    }
    if (name === 'config:export') { const selected = await dialog.showSaveDialog(window, { defaultPath: 'nyan-play-settings.json', filters: [{ name: '設定', extensions: ['json'] }] }); if (!selected.canceled) writeFileSync(selected.filePath, JSON.stringify(store.exportConfig(), null, 2)); return null; }
    if (name === 'config:import') {
      const selected = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '設定', extensions: ['json'] }] }); if (selected.canceled) return null;
      const buffer = readFileSync(selected.filePaths[0]); if (buffer.length > 5 * 1024 * 1024) throw new Error('設定ファイルが大きすぎます');
      const c = normalizeConfig(JSON.parse(buffer.toString()));
      for (const d of c.dictionary) if (d.regex) new RE2(d.source, 'gu');
      // Importing a backup never silently registers Windows startup or starts executables.
      c.desktop.autoStart = false; c.bot.autoConnect = false; c.speech.engineExecutable = '';
      c.android.sdkPath = ''; c.android.javaPath = '';
      return action('config:save', c);
    }
    if (name === 'open:docs') { await shell.openExternal('https://github.com/BLIMP-B/yt-nyan-play'); return null; }
    if (name === 'open:voicevox') { await shell.openExternal('https://voicevox.hiroshiba.jp/'); return null; }
    if (name === 'bouyomi:import') {
      const selected = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '棒読みちゃんのZIP', extensions: ['zip'] }] }); if (selected.canceled) return null;
      const info = bouyomi.import(selected.filePaths[0]); const c = store.exportConfig(); c.speech.provider = 'bouyomi'; c.speech.output = 'local'; c.speech.bouyomiHost = '127.0.0.1'; c.speech.bouyomiPort = info.port; c.speech.bouyomiHttpPort = info.httpPort; c.speech.bouyomiNativeRules = true; c.speech.bouyomiUseDefaults = true; return action('config:save', c);
    }
    if (name === 'bouyomi:start') { bouyomi.start(); return snapshot(); }
    if (name === 'bouyomi:stop') { await bouyomi.stop(); return snapshot(); }
    if (name === 'bouyomi:folder') { const error = await shell.openPath(bouyomi.directory); if (error) throw new Error(error); return null; }
    if (name === 'android:catalog') return android.refresh();
    if (name === 'android:setup') return android.setup(data);
    if (name === 'android:cancel') { android.cancelSetup(); return null; }
    if (name === 'android:start') return android.start();
    if (name === 'android:stop') { await android.stop(); return android.snapshot(); }
    if (name === 'android:play') return android.openPlay(data?.packageId || '');
    if (name === 'android:input') return android.input(data);
    if (name === 'android:choose-sdk') { const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory'] }); return selected.filePaths[0] || ''; }
    if (name === 'android:choose-java') { const selected = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Java実行ファイル', extensions: ['exe'] }] }); return selected.filePaths[0] || ''; }
    if (name === 'twitter:login') { const url = await twitter.login(); await shell.openExternal(url); return null; }
    if (name === 'twitter:logout') { twitter.logout(); return snapshot(); }
    if (name === 'twitter:app-token') { twitterAppVault.save(data); return snapshot(); }
    if (name === 'twitter:app-token-clear') { twitterAppVault.clear(); return snapshot(); }
    if (name === 'twitter:start') { twitter.start(); return snapshot(); }
    if (name === 'twitter:stop') { twitter.stop(); return snapshot(); }
    throw new Error('未対応の操作です');
  }
  const trusted = event => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame;
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    store = new Store(app.getPath('userData')); vault = new Vault(store.directory); engine = new EngineProcess((l, t) => store.log(l, t));
    bouyomi = new BouyomiImport(store.directory); bouyomi.on('change', emitState);
    android = new AndroidRuntime(store.directory, getConfig, (l, t) => store.log(l, t), (url, options) => net.fetch(url, options));
    android.on('change', emitState); android.on('frame', bytes => { if (window && !window.isDestroyed()) window.webContents.send('nyan:android-frame', bytes); });
    bot = new DiscordBot(store, {
      speech: payload => { store.enqueue('speech', payload); void speechRunner.drain(); },
      media: payload => media.enqueue(payload),
      join: guildId => voice.connect(guildId), leave: guildId => voice.disconnect(guildId), disconnect: () => voice.close(), control,
      speakers: () => new Voicevox(getConfig().speech.engineUrl).speakers(),
    });
    voice = new VoiceOutput(() => bot.client, getConfig, (l, t) => store.log(l, t));
    media = new MediaPool(store, scope => {
      let browser;
      browser = new MediaBrowser(getConfig, {
        changed: emitState,
        startCapture: (id, guildId) => {
          const master = scope === 'master';
          captureChain = captureChain.catch(() => {}).then(async () => {
            if (master) { for (const key of [...voice.connections.keys()]) { voice.endMedia(key); await voice.beginMedia(key); } } else await voice.beginMedia(guildId);
            captures.set(id, { guildId, master, window: browser.window }); captureRequest = id;
            try { await audioCommand('capture:start', { id }, null, 20000); }
            catch (e) { captures.delete(id); window.webContents.send('nyan:audio', { type: 'capture:stop', id }); if (master) for (const key of [...voice.connections.keys()]) voice.endMedia(key); else voice.endMedia(guildId); throw e; }
            finally { captureRequest = null; }
          }); return captureChain;
        },
        stopCapture: async (id, guildId) => { window.webContents.send('nyan:audio', { type: 'capture:stop', id }); captures.delete(id); if (scope === 'master') for (const key of [...voice.connections.keys()]) voice.endMedia(key); else voice.endMedia(guildId); },
      }, (l, t) => store.log(l, t)); return browser;
    });
    speechRunner = new JobRunner(store, 'speech', async (job, signal) => {
      const c = getConfig(); const profile = c.speech.profiles.find(p => p.userId === job.payload.userId);
      const settings = { ...c.speech, ...profile, ...(job.payload.styleId !== undefined ? { styleId: job.payload.styleId } : {}) };
      if (job.payload.privateOwnerId) { await twitter.userSession(); if (twitter.owner()?.id !== job.payload.privateOwnerId) throw new Error('非公開投稿は本人のXログイン中だけ読み上げます'); }
      const targets = speechTargets(job.payload.guildId, c.speech.forwarding);
      if (settings.output !== 'local' && !job.payload.guildId) throw new Error('Discordへの読み上げにはサーバーを選択してください');
      if (settings.output !== 'local') await Promise.all(targets.map(id => voice.connect(id)));
      if (settings.provider === 'bouyomi') { if (settings.output !== 'local') throw new Error('棒読みちゃん出力はローカル再生です。Discord音声にはVOICEVOXを選んでください'); await bouyomiSpeak(job.payload.text, settings, signal); return; }
      const audio = job.payload.clipPath ? readFileSync(job.payload.clipPath) : await new Voicevox(settings.engineUrl).synthesize([...job.payload.text].slice(0, settings.maxChars).join(''), settings, signal);
      if (audio.length > 30 * 1024 * 1024) throw new Error('音声クリップが大きすぎます');
      for (const target of targets.length ? targets : ['']) media.setDucked(true, target);
      const outputController = new AbortController(); const outputSignal = AbortSignal.any([signal, outputController.signal]); const outputs = [];
      try {
        if (settings.output !== 'discord') outputs.push(audioCommand('play', { bytes: audio, volume: settings.volume, device: settings.outputDevice }, outputSignal));
        if (settings.output !== 'local') for (const target of targets) outputs.push(voice.speech(target, audio, settings.volume, outputSignal));
        await Promise.all(outputs);
      } catch (e) { outputController.abort(); await Promise.allSettled(outputs); throw e; } finally { for (const target of targets.length ? targets : ['']) media.setDucked(false, target); }
    });
    twitterAppVault = new Vault(store.directory, 'twitter-app-token.bin');
    twitter = new TwitterSource(store.directory, getConfig, new Vault(store.directory, 'twitter-login.bin'), twitterAppVault, {
      speech: payload => { if (!store.seen.includes(`twitter:${payload.twitterId}`)) { store.enqueue('speech', payload); store.remember(`twitter:${payload.twitterId}`); void speechRunner.drain(); } },
      log: (level, text) => store.log(level, text), logout: () => { if (speechRunner.active?.job.payload.privateOwnerId) speechRunner.skip(); for (const job of store.jobs) if (job.payload.privateOwnerId) { job.payload.text = '[非公開投稿]'; if (job.status === 'waiting') job.status = 'cancelled'; } store.saveState(); },
    }, (url, options) => net.fetch(url, options)); twitter.on('change', emitState);
    window = new BrowserWindow({ width: 1260, height: 850, minWidth: 900, minHeight: 680, title: 'にゃんとーく〜Damare〜',
      icon: join(directory, '../../extension/furoneko70furoneko70.png'), backgroundColor: '#f6f7fb', show: false,
      webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
    const uiSession = window.webContents.session;
    uiSession.setPermissionCheckHandler((web, permission) => web === window.webContents && ['media', 'display-capture'].includes(permission));
    uiSession.setPermissionRequestHandler((web, permission, callback) => callback(web === window.webContents && ['media', 'display-capture'].includes(permission)));
    uiSession.setDisplayMediaRequestHandler((request, callback) => {
      const capture = captures.get(captureRequest);
      if (request.frame !== window.webContents.mainFrame || !capture || !capture.window || capture.window.isDestroyed()) return callback({});
      const frame = capture.window.webContents.mainFrame;
      callback({ video: frame, audio: frame, enableLocalEcho: getConfig().media.output === 'both' });
    });
    ipcMain.handle('nyan:action', async (event, name, data) => { if (!trusted(event)) throw new Error('操作元を確認できません'); try { return { ok: true, value: await action(name, data) }; } catch (e) { store.log('error', e.message); return { ok: false, error: e.message }; } });
    ipcMain.on('nyan:audio-result', (event, data) => { if (trusted(event) && typeof data?.id === 'string') pendingAudio.get(data.id)?.(data.error ? new Error(String(data.error).slice(0, 300)) : null); });
    ipcMain.on('nyan:pcm', (event, id, bytes) => { const capture = captures.get(id); if (!trusted(event) || !capture || !(bytes instanceof Uint8Array) || bytes.length > 32768 || bytes.length % 4) return; if (capture.master) { for (const key of [...voice.connections.keys()]) voice.media(key, Buffer.from(bytes)); } else if (!media.masterActive) voice.media(capture.guildId, Buffer.from(bytes)); });
    window.on('close', event => { if (!quitting && store.config.desktop.closeToTray) { event.preventDefault(); window.hide(); } });
    window.on('closed', () => { if (!quitting) app.quit(); });
    store.on('change', emitState);
    store.on('change', () => { const entry = store.logs[0]; if (entry?.level === 'error' && entry !== notifiedEntry && getConfig().desktop.notifications && Date.now() - notificationAt > 15000 && Notification.isSupported()) { notificationAt = Date.now(); notifiedEntry = entry; new Notification({ title: 'にゃんとーく〜Damare〜', body: entry.text }).show(); } });
    await window.loadFile(join(directory, 'renderer/index.html'));
    if (!smoke) await twitter.restore();
    tray = new Tray(join(directory, '../../extension/furoneko70furoneko70.png')); tray.setToolTip('にゃんとーく〜Damare〜');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'にゃんとーく〜Damare〜を開く', click: () => window.show() }, { label: 'Botを開始', click: () => startBot().catch(e => store.log('error', e.message)) }, { label: 'Botを停止', click: stopBot }, { type: 'separator' }, { label: '終了', click: () => app.quit() }]));
    tray.on('double-click', () => window.show());
    if (!getConfig().desktop.startMinimized && !process.argv.includes('--minimized')) window.show();
    if (getConfig().bot.autoConnect && vault.hasToken() && !smoke) await startBot().catch(e => store.log('error', e.message));
    powerMonitor.on('resume', () => { store.log('info', 'Windowsの復帰を検出しました'); if (getConfig().bot.autoConnect && bot.status === 'offline') void startBot().catch(e => store.log('error', e.message)); });
    if (smoke) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const verified = await window.webContents.executeJavaScript(`(async () => {
        const initial = await window.nyan.invoke('state');
        if (!initial.ok || document.querySelector('#style-id').options.length !== 8) return false;
        document.querySelector('[data-view="dictionary"]').click();
        document.querySelector('#dict-source').value = '<img src=x onerror=alert(1)>';
        document.querySelector('#dict-replacement').value = 'ねこ';
        document.querySelector('#dictionary-form').requestSubmit();
        await new Promise(resolve => setTimeout(resolve, 300));
        const saved = await window.nyan.invoke('state');
        if (!saved.ok || saved.value.config.dictionary.length !== 1 || document.querySelector('#dictionary-list img') || document.querySelector('[data-panel="dictionary"]').hidden) return false;
        document.querySelector('#theme-toggle').click();
        await new Promise(resolve => setTimeout(resolve, 300));
        const dark = await window.nyan.invoke('state');
        if (dark.value.config.desktop.theme !== 'dark' || document.body.dataset.theme !== 'dark' || !document.body.classList.contains('vs-dark')) return false;
        if (${process.env.NYAN_SCREENSHOT_THEME === 'dark'}) return true;
        document.querySelector('#theme-toggle').click();
        await new Promise(resolve => setTimeout(resolve, 300));
        return document.body.dataset.theme === 'light';
      })()`, true);
      if (!verified) throw new Error('画面と設定保存のスモークテストが失敗しました');
      if (process.env.NYAN_SCREENSHOT_PATH) { window.webContents.executeJavaScript(`document.querySelector('[data-view="overview"]').click()`); await new Promise(resolve => setTimeout(resolve, 150)); const picture = await window.webContents.capturePage(); writeFileSync(process.env.NYAN_SCREENSHOT_PATH, picture.toPNG()); }
      console.log('NYAN_SMOKE_READY'); app.quit();
    }
  }).catch(e => { console.error(e.message); if (app.isReady()) dialog.showErrorBox('にゃんとーく〜Damare〜を起動できません', e.message); app.quit(); });
  app.on('before-quit', () => { quitting = true; if (bot) stopBot(); engine?.stop(); void bouyomi?.stop().catch(() => {}); android?.close(); twitter?.close(); media?.close(); for (const finish of pendingAudio.values()) finish(new Error('アプリを終了します')); tray?.destroy(); });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}

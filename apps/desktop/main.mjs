import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification, powerMonitor, net } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Store } from './core/store.mjs';
import { normalizeConfig } from './core/config.mjs';
import { RE2 } from 're2-wasm';
import { SpeechPool } from './core/speech-pool.mjs';
import { Voicevox } from './core/voicevox.mjs';
import { parseMediaCommand, mediaAnnouncement } from './core/protocol.mjs';
import { DiscordBot } from './runtime/bot.mjs';
import { APP_ICON, APP_ID } from './runtime/app-icon.mjs';
import { VoiceOutput, decodeAudio } from './runtime/voice-output.mjs';
import { HourlyRuntime } from './runtime/hourly.mjs';
import { HourlyHistory } from './runtime/hourly-history.mjs';
import { HourlyModel } from './runtime/hourly-model.mjs';
import { searchHourlyBgm } from './runtime/hourly-bgm.mjs';
import { pcmWav } from './core/hourly-audio.mjs';
import { MediaBrowser } from './runtime/media-browser.mjs';
import { MediaAccounts } from './runtime/media-accounts.mjs';
import { ChatEducation } from './runtime/chat-education.mjs';
import { MEDIA_ACCOUNTS } from './core/media-accounts.mjs';
import { Vault } from './runtime/vault.mjs';
import { EngineProcess } from './runtime/engine-process.mjs';
import { BouyomiImport, inspectBouyomi } from './runtime/bouyomi-import.mjs';
import { BouyomiProcessor } from './runtime/bouyomi-processor.mjs';
import { runNativeSpeech, nativeSpeechDefaults } from './core/bouyomi-pipeline.mjs';
import { bouyomiSpeak } from './runtime/bouyomi.mjs';
import { AndroidRuntime } from './runtime/android.mjs';
import { TwitterSource } from './runtime/twitter.mjs';
import { MediaPool } from './core/media-pool.mjs';
import { speechTargets, applyDictionary } from './core/text.mjs';
import { resolveDestination } from './core/destination.mjs';
import { AudioBridge } from './runtime/audio-bridge.mjs';
import { browserUserAgent } from './core/browser-user-agent.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');
const smokeCatalog = smoke && process.env.NYAN_SMOKE_CATALOG ? JSON.parse(process.env.NYAN_SMOKE_CATALOG) : [];
app.setName('にゃんとーく〜Damare〜');
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
app.setPath('userData', join(app.getPath('appData'), 'nyan-talk-damare'));
if (process.env.NYAN_DATA_DIR) app.setPath('userData', process.env.NYAN_DATA_DIR);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window, tray, store, vault, bot, voice, media, accounts, speechRunner, engine, android, twitter, twitterAppVault, bouyomi, bouyomiProcessor, hourly, hourlyHistory, hourlyModel;
  let historyController, historyTimer;
  let quitting = false; let stateTimer; let notificationAt = 0; let notifiedEntry; const audioBridge = new AudioBridge(() => window); const captures = new Map(); let captureRequest = null; let captureChain = Promise.resolve();
  const getConfig = () => store.config;
  const emitState = () => {
    if (bot && media) bot.updateMediaActivity(media.status);
    if (stateTimer || !window || window.isDestroyed()) return;
    stateTimer = setTimeout(() => { stateTimer = null; if (!window.isDestroyed()) window.webContents.send('nyan:state', snapshot()); }, 80);
  };
  const snapshot = () => ({ version: app.getVersion(), config: store.exportConfig(), tokenSaved: vault.hasToken(), vaultAvailable: vault.available(),
    bot: { status: bot.status, name: bot.client?.user?.username || '', startedAt: bot.startedAt, servers: smoke ? smokeCatalog : bot.catalog() },
    voices: voice.snapshot(), jobs: structuredClone(store.jobs).reverse(), logs: store.logs, mediaAccounts: MEDIA_ACCOUNTS.map(({ id, name }) => ({ id, name })),
    paused: { speech: speechRunner.paused, media: media.paused }, media: media.status, engineRunning: Boolean(engine.child), android: android.snapshot(), twitter: twitter.snapshot(), bouyomi: bouyomi.snapshot(),
    hourly: hourly ? { ...hourly.snapshot(), history: hourlyHistory.snapshot(), model: hourlyModel.snapshot() } : null });
  const audioCommand = (...args) => audioBridge.command(...args);
  const control = (name, guildId) => {
    if (name === 'pause' || name === 'resume') { const paused = name === 'pause'; if (guildId) speechRunner.pauseGuild(guildId, paused); else speechRunner.pause(paused); media.pause(paused, guildId); }
    if (name === 'skip') media.skip(guildId);
    if (name === 'stop') { speechRunner.clear(guildId); media.clear(guildId); }
  };
  async function stopRequested({ guildId, master }) {
    const scope = master ? 'master' : guildId || 'local';
    const targets = master ? [...voice.connections.keys()] : [guildId];
    for (const id of targets) { voice.holdSpeech(id, true); voice.interruptSpeech(id); }
    media.clear(scope);
    try { await speechRunner.speak({ text: 'さいせいをていししました', guildId, master, system: true, priority: 100, output: getConfig().media.output }, { interrupt: true }); }
    finally { for (const id of targets) voice.holdSpeech(id, false); }
  }
  async function startBot() {
    if (bot.status !== 'offline') return;
    if (getConfig().speech.engineExecutable && !engine.child) engine.start(getConfig().speech.engineExecutable, getConfig().speech.engineUrl);
    await bot.start(vault.read());
    speechRunner.halt(false); speechRunner.pause(false); media.pause(false); media.drain();
    syncHourlyHistory();
  }
  function syncHourlyHistory() {
    if (!getConfig().hourly.servers.some(s => s.enabled) || !bot.client?.isReady()) return;
    historyController ||= new AbortController();
    if (hourlyHistory.syncing) { const signal = historyController.signal; void hourlyHistory.syncing.catch(() => {}).finally(() => { if (!signal.aborted) syncHourlyHistory(); }); return; }
    void hourlyHistory.sync(historyController.signal).catch(error => { if (error.name !== 'AbortError') store.log('warn', `時報履歴: ${error.message}`); });
  }
  function stopBot() { hourly?.cancel(); historyController?.abort(); historyController = null; speechRunner?.pause(true); speechRunner?.halt(true); media?.pause(true); media?.skip(); bot?.stop(); }
  async function action(name, data) {
    if (name === 'state') return snapshot();
    if (name === 'config:save') {
      const c = normalizeConfig(data);
      if ((android.child || android.busy) && JSON.stringify(c.android) !== JSON.stringify(store.config.android)) throw new Error('Androidの停止後に仮想環境の設定を変更してください');
      if (hourlyModel.busy && JSON.stringify(c.hourly) !== JSON.stringify(store.config.hourly)) throw new Error('SLMの導入が終わるか中止してから時報設定を変更してください');
      const hourlyChanged = JSON.stringify(c.hourly) !== JSON.stringify(store.config.hourly);
      if (hourlyChanged) { hourly.cancel(); historyController?.abort(); historyController = null; }
      if (c.hourly.slmUrl !== store.config.hourly.slmUrl) await hourlyModel.stop();
      for (const d of c.dictionary) if (d.regex) new RE2(d.source, d.caseSensitive ? 'gu' : 'giu');
      store.updateConfig(c); if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: c.desktop.autoStart, args: c.desktop.startMinimized ? ['--minimized'] : [] });
      if (hourlyChanged) { hourly.update(); syncHourlyHistory(); }
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
      const payload = resolveDestination({ text: data.text, guildId: String(data.guildId || ''), userId: '', styleId: Number(data.styleId ?? getConfig().speech.styleId) }, getConfig().speech.output, getConfig().bot.bindings, voice.snapshot());
      if (getConfig().speech.output !== 'local') await voice.connect(payload.guildId);
      return speechRunner.enqueue(payload);
    }
    if (name === 'media:add') {
      const command = parseMediaCommand(`${String(data?.url || '')}${{ preview: '再生', full: '無限', direct: '直接' }[data?.mode] || (data?.loop ? '無限' : '再生')}`, getConfig());
      if (!command) throw new Error('再生URLを入力してください');
      const payload = resolveDestination({ ...command, master: data?.master === true, guildId: String(data.guildId || ''), startSeconds: Math.max(0, Math.min(86400, Number(data.startSeconds) || command.startSeconds)), title: command.title }, getConfig().media.output, getConfig().bot.bindings, voice.snapshot());
      if (getConfig().media.output !== 'local' && !payload.master) await voice.connect(payload.guildId);
      return media.enqueue(payload);
    }
    if (name === 'control') { if (!['pause', 'resume', 'skip', 'stop'].includes(data)) throw new Error('未対応の操作です'); control(data); return snapshot(); }
    if (name === 'media:show') { media.show(); return null; }
    if (name === 'media:login') { await accounts.open(data); return null; }
    if (name === 'hourly:test') { await hourly.test(String(data?.guildId || '')); return snapshot(); }
    if (name === 'hourly:cancel') { hourly.cancel(); return snapshot(); }
    if (name === 'hourly:sync') { historyController ||= new AbortController(); await hourlyHistory.sync(historyController.signal); return snapshot(); }
    if (name === 'hourly:sync-cancel') { historyController?.abort(); historyController = null; return snapshot(); }
    if (name === 'hourly:history-clear') { hourlyHistory.clear(); return snapshot(); }
    if (name === 'hourly:model-setup') { await hourlyModel.setup(); return snapshot(); }
    if (name === 'hourly:model-cancel') { hourlyModel.cancel(); return snapshot(); }
    if (name === 'hourly:generate') {
      const server = getConfig().hourly.servers.find(s => s.guildId === data?.guildId && s.enabled); if (!server) throw new Error('生成文を有効にしたサーバーを選択してください');
      return hourly.generate(server, Date.now(), AbortSignal.timeout(getConfig().hourly.generationTimeoutSeconds * 1000 + 30000));
    }
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
      const info = bouyomi.import(selected.filePaths[0]); const c = store.exportConfig(); c.speech.provider = 'voicevox'; c.speech.output = 'discord'; c.speech.bouyomiHost = '127.0.0.1'; c.speech.bouyomiPort = info.port; c.speech.bouyomiHttpPort = info.httpPort; c.speech.bouyomiNativeRules = true; c.speech.bouyomiUseDefaults = true; c.speech.bouyomiPreprocess = true; return action('config:save', c);
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
    app.userAgentFallback = browserUserAgent(app.userAgentFallback);
    store = new Store(app.getPath('userData')); vault = new Vault(store.directory); engine = new EngineProcess((l, t) => store.log(l, t));
    bouyomi = new BouyomiImport(store.directory); bouyomi.on('change', emitState);
    bouyomiProcessor = new BouyomiProcessor(store.directory);
    android = new AndroidRuntime(store.directory, getConfig, (l, t) => store.log(l, t), (url, options) => net.fetch(url, options));
    accounts = new MediaAccounts(getConfig, (l, t) => store.log(l, t));
    const education = new ChatEducation(store, () => {
      if (!getConfig().speech.bouyomiPreprocess || getConfig().speech.provider !== 'voicevox') return null;
      if (bouyomi.child) throw new Error('教育辞書を更新するには元の棒読みちゃんを終了してください');
      return bouyomiProcessor;
    });
    android.on('change', emitState); android.on('frame', bytes => { if (window && !window.isDestroyed()) window.webContents.send('nyan:android-frame', bytes); });
    bot = new DiscordBot(store, {
      speech: payload => { store.enqueue('speech', payload); void speechRunner.drain(); },
      education: command => education.apply(command),
      media: payload => media.enqueue(payload), stopRequested,
      join: guildId => voice.connect(guildId), leave: guildId => voice.disconnect(guildId), disconnect: () => voice.close(), control,
      speakers: () => new Voicevox(getConfig().speech.engineUrl).speakers(),
      ready: () => syncHourlyHistory(),
      history: message => hourlyHistory?.record(message), historyDelete: id => hourlyHistory?.deleted(id),
    });
    voice = new VoiceOutput(() => bot.client, getConfig, (l, t) => store.log(l, t));
    const createBrowser = (scope, bed = false) => {
      let browser;
      const browserConfig = bed ? () => ({ ...getConfig(), media: { ...getConfig().media, output: getConfig().hourly.output, volume: getConfig().hourly.bgmVolume, showWindow: false } }) : getConfig;
      browser = new MediaBrowser(browserConfig, {
        changed: emitState,
        captureError: id => {
          const capture = captures.get(id); if (!capture) return;
          if (capture.error) return capture.error;
          if (!capture.master && !voice.connections.has(capture.guildId)) return 'Discordの音声接続が終了しました。再試行すると再接続します';
          if (capture.master && !voice.connections.size) return 'マスタ再生の送信先VCがありません';
        },
        startCapture: (id, guildId, signal) => {
          const master = scope === 'master';
          captureChain = captureChain.catch(() => {}).then(async () => {
            signal.throwIfAborted();
            if (bed) await voice.beginBackground(guildId);
            else if (master) { for (const key of [...voice.connections.keys()]) { voice.endMedia(key); await voice.beginMedia(key); } } else await voice.beginMedia(guildId);
            signal.throwIfAborted();
            captures.set(id, { guildId, master, bed, output: browserConfig().media.output, window: browser.window }); captureRequest = id;
            try { await audioCommand('capture:start', { id }, signal, 20000); }
            catch (e) { captures.delete(id); window.webContents.send('nyan:audio', { type: 'capture:stop', id }); if (bed) voice.endBackground(guildId); else if (master) for (const key of [...voice.connections.keys()]) voice.endMedia(key); else voice.endMedia(guildId); throw e; }
            finally { captureRequest = null; }
          }); return captureChain;
        },
        stopCapture: async (id, guildId) => { window.webContents.send('nyan:audio', { type: 'capture:stop', id }); if (!captures.delete(id)) return; if (bed) voice.endBackground(guildId); else if (scope === 'master') for (const key of [...voice.connections.keys()]) voice.endMedia(key); else voice.endMedia(guildId); },
      }, (l, t) => store.log(l, t), accounts); return browser;
    };
    media = new MediaPool(store, scope => createBrowser(scope), async (job, signal) => {
      if (job.payload.mode === 'direct') return;
      await speechRunner.speak({ text: mediaAnnouncement(job.payload.url), guildId: job.payload.guildId, master: job.payload.master, system: true, priority: 50, output: getConfig().media.output }, { signal });
    });
    speechRunner = new SpeechPool(store, async (job, signal) => {
      const c = getConfig(); const profile = c.speech.profiles.find(p => p.userId === job.payload.userId);
      let settings = { ...c.speech, ...(!job.payload.system ? profile : {}), ...(job.payload.styleId !== undefined ? { styleId: job.payload.styleId } : {}), ...(job.payload.system ? { provider: 'voicevox', output: job.payload.output || c.speech.output } : {}) };
      if ((job.payload.system || job.payload.literal) && settings.bouyomiPreprocess && settings.bouyomiUseDefaults) {
        const pending = store.jobs.filter(j => j.kind === 'speech' && ['waiting', 'running'].includes(j.status) && j.payload.guildId === job.payload.guildId).reduce((n, j) => n + String(j.payload.text || '').length, 0);
        settings = nativeSpeechDefaults(settings, inspectBouyomi(bouyomi.directory).settings, pending);
      }
      if (job.payload.privateOwnerId) { await twitter.userSession(); if (twitter.owner()?.id !== job.payload.privateOwnerId) throw new Error('非公開投稿は本人のXログイン中だけ読み上げます'); }
      const targets = job.payload.master ? [...voice.connections.keys()] : job.payload.system ? (job.payload.guildId ? [job.payload.guildId] : []) : speechTargets(job.payload.guildId, c.speech.forwarding);
      if (settings.output !== 'local' && !targets.length) throw new Error('Discordへの読み上げにはサーバーを選択し、マスタ再生にはVCへ接続してください');
      if (settings.output !== 'local') await Promise.all(targets.map(id => voice.connect(id)));
      if (settings.provider === 'bouyomi') { if (settings.output !== 'local') throw new Error('棒読みちゃん出力はローカル再生です。Discord音声にはVOICEVOXを選んでください'); await bouyomiSpeak(job.payload.text, settings, signal); return; }
      const output = async (text, outputSettings, outputJobSignal, clipPath) => {
      const audio = clipPath ? readFileSync(clipPath) : await new Voicevox(outputSettings.engineUrl).synthesize(text, outputSettings, outputJobSignal);
      if (audio.length > 30 * 1024 * 1024) throw new Error('音声クリップが大きすぎます');
      for (const target of targets.length ? targets : ['']) media.setDucked(true, target);
      const outputController = new AbortController(); const outputSignal = AbortSignal.any([outputJobSignal, outputController.signal]); const outputs = [];
      try {
        if (outputSettings.output !== 'discord') outputs.push(audioCommand('play', { bytes: audio, volume: outputSettings.volume, device: outputSettings.outputDevice }, outputSignal));
        if (outputSettings.output !== 'local') for (const target of targets) outputs.push(voice.speech(target, audio, outputSettings.volume, outputSignal, job.payload.priority || 0));
        await Promise.all(outputs);
      } catch (e) { outputController.abort(); await Promise.allSettled(outputs); throw e; } finally { for (const target of targets.length ? targets : ['']) media.setDucked(false, target); }
      };
      if (settings.bouyomiPreprocess && !job.payload.system && !job.payload.literal && !job.payload.clipPath) {
        if (bouyomi.child) throw new Error('辞書への同時書き込みを防ぐため元アプリを終了してください');
        const { settings: original } = inspectBouyomi(bouyomi.directory);
        const pendingCharacters = store.jobs.filter(j => j.kind === 'speech' && ['waiting', 'running'].includes(j.status) && j.payload.guildId === job.payload.guildId).reduce((n, j) => n + String(j.payload.text || '').length, 0);
        const pipelineController = new AbortController(); const pipelineSignal = AbortSignal.any([signal, pipelineController.signal]);
        try { await runNativeSpeech({ text: job.payload.text, settings, original, pendingCharacters, processor: bouyomiProcessor,
          output: (text, options, textSignal) => output(applyDictionary(text, c.dictionary, job.payload), options, textSignal), log: (l, text) => store.log(l, text),
          sound: async (name, options, original, soundSignal) => {
            if (original.SoundDisablePath === 'true' && (isAbsolute(name) || name.split(/[\\/]/).includes('..'))) throw new Error('Soundタグの外部パスは無効です');
            const base = resolve(bouyomi.directory, original.SoundPath || 'Sound'); let file = resolve(base, name);
            if (!existsSync(file)) file = ['wav', 'mp3', 'wma', 'ogg'].map(ext => `${file}.${ext}`).find(existsSync);
            if (!file) throw new Error('Soundタグの音声素材が見つかりません');
            await output('', { ...options, volume: Number(original.SoundVolume || 100) / 100 }, soundSignal, file);
          },
        }, pipelineSignal); } catch (error) { pipelineController.abort(); throw error; }
      } else await output(job.payload.system ? job.payload.text : [...job.payload.text].slice(0, settings.maxChars).join(''), settings, signal, job.payload.clipPath);
    });
    hourlyHistory = new HourlyHistory(store.directory, () => bot.client, getConfig, emitState);
    hourlyModel = new HourlyModel(store.directory, getConfig, (url, options) => net.fetch(url, options)); hourlyModel.on('change', emitState);
    hourly = new HourlyRuntime(store.directory, getConfig, {
      history: hourlyHistory, model: hourlyModel, fetcher: (url, options) => net.fetch(url, options),
      log: (level, text) => store.log(level, text), targets: () => [...voice.connections.keys()], reserve: scopes => speechRunner.reserve(scopes),
      hold: (id, value) => { voice.holdSpeech(id, value); if (value) voice.interruptSpeech(id); },
      synthesize: async (text, signal) => decodeAudio(await new Voicevox(getConfig().speech.engineUrl).synthesize(text, getConfig().speech, signal), signal),
      fadeMedia: (gain, ms, scope) => { media.fadeOverlay(gain, ms, scope); for (const id of voice.connections.keys()) voice.fadeMedia(id, Math.min(media.overlayGains.get('*') ?? 1, media.overlayGains.get(id) ?? 1), ms); },
      play: async (pcm, targets, signal, startAt = 0) => {
        const c = getConfig(); const outputs = []; const controller = new AbortController(), outputSignal = AbortSignal.any([signal, controller.signal]);
        if (c.hourly.output !== 'discord') outputs.push(audioCommand('play:timed', { bytes: pcmWav(pcm), volume: c.hourly.volume, device: c.speech.outputDevice, startAt: startAt || Date.now() }, outputSignal));
        if (c.hourly.output !== 'local') for (const id of targets) outputs.push(voice.pcm(id, pcm, c.hourly.volume, outputSignal, startAt));
        try { await Promise.all(outputs); } catch (error) { controller.abort(); await Promise.allSettled(outputs); throw error; }
      },
      background: async (nouns, guildId, signal) => {
        const found = await searchHourlyBgm(nouns, getConfig, signal); const browser = createBrowser(guildId, true), controller = new AbortController();
        const bgmSignal = AbortSignal.any([signal, controller.signal]); let error, done = false;
        const task = browser.play({ id: crypto.randomUUID(), payload: { ...found, mode: 'direct', guildId, background: true } }, bgmSignal).catch(e => { if (!bgmSignal.aborted) error = e; }).finally(() => { done = true; });
        const stop = async () => { controller.abort(); await task; browser.close(); };
        try {
          const until = Date.now() + 15000;
          while (Date.now() < until) { signal.throwIfAborted(); if (error) throw error; if (browser.status?.loginRequired) throw new Error(browser.status.blockedReason || 'YouTubeへのログインが必要です'); if (browser.status?.startedAt && browser.status.currentTime > 0) break; if (done) throw new Error('BGMが開始前に終了しました'); await new Promise(resolve => setTimeout(resolve, 100)); }
          if (!browser.status?.startedAt) throw new Error('BGMの再生開始を確認できません');
          return { stop, fade: async (ms, fadeSignal) => { browser.setOverlayGain(0, ms); voice.fadeBackground(guildId, 0, ms); await new Promise((resolve, reject) => { const timer = setTimeout(finished, ms); const abort = () => { clearTimeout(timer); fadeSignal?.removeEventListener('abort', abort); reject(fadeSignal.reason); }; function finished() { fadeSignal?.removeEventListener('abort', abort); resolve(); } fadeSignal?.addEventListener('abort', abort, { once: true }); }); } };
        } catch (e) { await stop(); throw e; }
      },
    }); hourly.on('change', emitState);
    twitterAppVault = new Vault(store.directory, 'twitter-app-token.bin');
    twitter = new TwitterSource(store.directory, getConfig, new Vault(store.directory, 'twitter-login.bin'), twitterAppVault, {
      speech: payload => { if (!store.seen.includes(`twitter:${payload.twitterId}`)) { store.enqueue('speech', payload); store.remember(`twitter:${payload.twitterId}`); void speechRunner.drain(); } },
      log: (level, text) => store.log(level, text), logout: () => { for (const job of speechRunner.activeJobs) if (job.payload.privateOwnerId) speechRunner.forJob(job).skip(); for (const job of store.jobs) if (job.payload.privateOwnerId) { job.payload.text = '[非公開投稿]'; if (job.status === 'waiting') job.status = 'cancelled'; } store.saveState(); },
    }, (url, options) => net.fetch(url, options)); twitter.on('change', emitState);
    window = new BrowserWindow({ width: 1260, height: 850, minWidth: 900, minHeight: 680, title: 'にゃんとーく〜Damare〜',
      icon: APP_ICON, backgroundColor: '#f6f7fb', show: false,
      webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
    const uiSession = window.webContents.session;
    uiSession.setPermissionCheckHandler((web, permission) => web === window.webContents && ['media', 'display-capture'].includes(permission));
    uiSession.setPermissionRequestHandler((web, permission, callback) => callback(web === window.webContents && ['media', 'display-capture'].includes(permission)));
    uiSession.setDisplayMediaRequestHandler((request, callback) => {
      const capture = captures.get(captureRequest);
      if (request.frame !== window.webContents.mainFrame || !capture || !capture.window || capture.window.isDestroyed()) return callback({});
      const frame = capture.window.webContents.mainFrame;
      callback({ video: frame, audio: frame, enableLocalEcho: capture.output === 'both' });
    });
    ipcMain.handle('nyan:action', async (event, name, data) => { if (!trusted(event)) throw new Error('操作元を確認できません'); try { return { ok: true, value: await action(name, data) }; } catch (e) { store.log('error', e.message); return { ok: false, error: e.message }; } });
    ipcMain.on('nyan:audio-result', (event, data) => {
      if (!trusted(event)) return;
      if (data?.type === 'capture:error' && captures.has(data.id)) captures.get(data.id).error = String(data.error || 'メディア音声の転送が停止しました').slice(0, 300);
      else audioBridge.result(data);
    });
    ipcMain.on('nyan:pcm', (event, id, bytes) => { const capture = captures.get(id); if (!trusted(event) || !capture || !(bytes instanceof Uint8Array) || bytes.length > 32768 || bytes.length % 4) return; if (capture.bed) voice.background(capture.guildId, Buffer.from(bytes)); else if (capture.master) { for (const key of [...voice.connections.keys()]) voice.media(key, Buffer.from(bytes)); } else if (!media.masterActive) voice.media(capture.guildId, Buffer.from(bytes)); });
    window.on('close', event => { if (!quitting && store.config.desktop.closeToTray) { event.preventDefault(); window.hide(); } });
    window.on('closed', () => { if (!quitting) app.quit(); });
    window.webContents.on('render-process-gone', () => audioBridge.close());
    store.on('change', emitState);
    store.on('change', () => { const entry = store.logs[0]; if (entry?.level === 'error' && entry !== notifiedEntry && getConfig().desktop.notifications && Date.now() - notificationAt > 15000 && Notification.isSupported()) { notificationAt = Date.now(); notifiedEntry = entry; new Notification({ title: 'にゃんとーく〜Damare〜', body: entry.text }).show(); } });
    await window.loadFile(join(directory, 'renderer/index.html'));
    if (!smoke) { hourly.start(); historyTimer = setInterval(syncHourlyHistory, 5 * 60000); historyTimer.unref(); }
    if (!smoke) await twitter.restore();
    tray = new Tray(APP_ICON); tray.setToolTip('にゃんとーく〜Damare〜');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'にゃんとーく〜Damare〜を開く', click: () => window.show() }, { label: 'Botを開始', click: () => startBot().catch(e => store.log('error', e.message)) }, { label: 'Botを停止', click: stopBot }, { type: 'separator' }, { label: '終了', click: () => app.quit() }]));
    tray.on('double-click', () => window.show());
    if (!getConfig().desktop.startMinimized && !process.argv.includes('--minimized')) window.show();
    if (getConfig().bot.autoConnect && vault.hasToken() && !smoke) await startBot().catch(e => store.log('error', e.message));
    powerMonitor.on('resume', () => { hourly.cancel(); hourly.update(); store.log('info', 'Windowsの復帰を検出しました'); if (getConfig().bot.autoConnect && bot.status === 'offline') void startBot().catch(e => store.log('error', e.message)); });
    if (smoke) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const verified = await window.webContents.executeJavaScript(`(async () => {
        const initial = await window.nyan.invoke('state');
        if (!initial.ok || document.querySelector('#style-id').options.length !== 8) return false;
        if ([...document.querySelector('#media-mode').options].map(o => o.value).join(',') !== 'preview,full,direct' || document.querySelector('#media-loop')) return false;
        const themeButton = document.querySelector('#theme-toggle');
        const iconButton = (button, icon, label) => button?.dataset.icon === icon && button.getAttribute('aria-label') === label && button.title === label && button.querySelector('svg use') && !button.textContent.trim();
        if (!iconButton(themeButton, 'moon', 'ダークモードに切り替え')) return false;
        if ([...document.querySelectorAll('button')].some(button => !button.querySelector('svg use') || !button.getAttribute('aria-label') || !button.title)) return false;
        for (const button of document.querySelectorAll('nav button')) {
          button.click();
          if (document.querySelector('#page-title').textContent !== button.dataset.label || document.querySelector('[data-panel="' + button.dataset.view + '"]').hidden) return false;
        }
        document.querySelector('#pause-toggle').click();
        await new Promise(resolve => setTimeout(resolve, 150));
        const paused = await window.nyan.invoke('state');
        if (!paused.value.paused.media || !paused.value.paused.speech || !iconButton(document.querySelector('#pause-toggle'), 'play', '再開')) return false;
        document.querySelector('#pause-toggle').click();
        await new Promise(resolve => setTimeout(resolve, 150));
        if (!iconButton(document.querySelector('#pause-toggle'), 'pause', '一時停止')) return false;
        document.querySelector('[data-view="dictionary"]').click();
        if (document.querySelector('#page-title').textContent !== '読み方の辞書') return false;
        document.querySelector('#dict-source').value = '<img src=x onerror=alert(1)>';
        document.querySelector('#dict-replacement').value = 'ねこ';
        document.querySelector('#dictionary-form').requestSubmit();
        await new Promise(resolve => setTimeout(resolve, 300));
        const saved = await window.nyan.invoke('state');
        if (!saved.ok || saved.value.config.dictionary.length !== 1 || document.querySelector('#dictionary-list img') || document.querySelector('[data-panel="dictionary"]').hidden) return false;
        const remove = document.querySelector('#dictionary-list button');
        if (!iconButton(remove, 'trash-2', '<img src=x onerror=alert(1)> → ねこを削除')) return false;
        remove.click();
        await new Promise(resolve => setTimeout(resolve, 150));
        if ((await window.nyan.invoke('state')).value.config.dictionary.length !== 0) return false;
        document.querySelector('[data-view="connections"]').click();
        const guild = '100000000000000001';
        const card = () => document.querySelector('[data-guild="' + guild + '"]');
        const picker = card().querySelector('select'); picker.value = '100000000000000002'; picker.dispatchEvent(new Event('change'));
        await new Promise(resolve => setTimeout(resolve, 150));
        const channel = () => card().querySelector('[data-channel="100000000000000003"]');
        if (channel().disabled || channel().checked || !card().querySelector('[data-channel="100000000000000005"]').disabled) return false;
        channel().click();
        await new Promise(resolve => setTimeout(resolve, 150));
        if (!(await window.nyan.invoke('state')).value.config.bot.bindings[0].textChannelIds.includes('100000000000000003') || !channel().checked) return false;
        channel().click();
        await new Promise(resolve => setTimeout(resolve, 150));
        let binding = (await window.nyan.invoke('state')).value.config.bot.bindings[0];
        if (binding.disabledTextChannelIds.join(',') !== '100000000000000003' || channel().checked || !binding.textChannelIds.includes('100000000000000003')) return false;
        const all = () => card().querySelector('[data-focus-key="' + guild + ':all"]');
        if (!all().indeterminate) return false;
        all().click();
        await new Promise(resolve => setTimeout(resolve, 150));
        binding = (await window.nyan.invoke('state')).value.config.bot.bindings[0];
        if (!all().checked || binding.textChannelIds.length !== 3 || binding.disabledTextChannelIds.length || binding.textChannelIds.includes('100000000000000005')) return false;
        const read = () => card().querySelector('[data-focus-key="' + guild + ':read"]');
        read().click();
        await new Promise(resolve => setTimeout(resolve, 150));
        if ((await window.nyan.invoke('state')).value.config.bot.bindings[0].readEnabled !== false || read().checked || !channel().checked) return false;
        card().querySelector('[data-focus-key="' + guild + ':notify"]').click();
        await new Promise(resolve => setTimeout(resolve, 150));
        if ((await window.nyan.invoke('state')).value.config.bot.bindings[0].announceJoinLeave !== true) return false;
        card().querySelector('select').value = '100000000000000006'; card().querySelector('select').dispatchEvent(new Event('change'));
        await new Promise(resolve => setTimeout(resolve, 150));
        binding = (await window.nyan.invoke('state')).value.config.bot.bindings[0];
        if (binding.voiceChannelId !== '100000000000000006' || !binding.textChannelIds.includes('100000000000000002') || !card().querySelector('[data-channel="100000000000000002"]').checked) return false;
        card().querySelector('[data-icon="trash-2"]').click();
        await new Promise(resolve => setTimeout(resolve, 150));
        if ((await window.nyan.invoke('state')).value.config.bot.bindings.length !== 0) return false;
        document.querySelector('#binding-manual').open = true;
        for (const [id, value] of Object.entries({ 'binding-guild': guild, 'binding-label': 'にゃんとーく', 'binding-voice': '100000000000000002', 'binding-text': '100000000000000003,100000000000000004' })) document.getElementById(id).value = value;
        document.querySelector('#binding-form').requestSubmit();
        await new Promise(resolve => setTimeout(resolve, 150));
        binding = (await window.nyan.invoke('state')).value.config.bot.bindings[0];
        if (!binding.readEnabled || binding.textChannelIds.length !== 2 || !channel().checked) return false;
        document.querySelector('#binding-manual').open = false;
        document.querySelector('#theme-toggle').click();
        await new Promise(resolve => setTimeout(resolve, 300));
        const dark = await window.nyan.invoke('state');
        if (dark.value.config.desktop.theme !== 'dark' || document.body.dataset.theme !== 'dark' || !document.body.classList.contains('vs-dark') || !iconButton(themeButton, 'sun', 'ライトモードに切り替え')) return false;
        const themeStyle = getComputedStyle(document.body);
        if (themeStyle.getPropertyValue('--line').trim() !== themeStyle.getPropertyValue('--vscode-editorGroup-border').trim() || themeStyle.getPropertyValue('--muted').trim() !== themeStyle.getPropertyValue('--vscode-descriptionForeground').trim()) return false;
        if (${process.env.NYAN_SCREENSHOT_THEME === 'dark'}) return true;
        document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, code: 'KeyL', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 300));
        return document.body.dataset.theme === 'light' && iconButton(themeButton, 'moon', 'ダークモードに切り替え');
      })()`, true);
      if (!verified) throw new Error('画面と設定保存のスモークテストが失敗しました');
      if (process.env.NYAN_SCREENSHOT_PATH) { const panel = process.env.NYAN_SCREENSHOT_PANEL === 'connections' ? 'connections' : 'overview'; await window.webContents.executeJavaScript(`document.querySelector('[data-view="${panel}"]').click(); document.querySelector('#toast').hidden = true;`); await new Promise(resolve => setTimeout(resolve, 150)); const picture = await window.webContents.capturePage(); writeFileSync(process.env.NYAN_SCREENSHOT_PATH, picture.toPNG()); }
      console.log('NYAN_SMOKE_READY'); app.quit();
    }
  }).catch(e => { console.error(e.message); if (app.isReady()) dialog.showErrorBox('にゃんとーく〜Damare〜を起動できません', e.message); app.quit(); });
  app.on('before-quit', () => { quitting = true; hourly?.close(); clearInterval(historyTimer); hourlyModel?.close(); if (bot) stopBot(); engine?.stop(); void bouyomi?.stop().catch(() => {}); android?.close(); twitter?.close(); media?.close(); accounts?.close(); audioBridge.close(); tray?.destroy(); });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}

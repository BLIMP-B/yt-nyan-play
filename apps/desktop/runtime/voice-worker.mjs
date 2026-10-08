import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { audioNetwork } from '../core/audio-network.mjs';

class RemoteMonitor {
  constructor(owner) { this.owner = owner; this.state = { id: '', guildId: '', channelId: '', status: 'waiting', users: 0, rendererMs: audioNetwork().rendererMs, error: '' }; this.error = ''; }
  snapshot() { return { ...this.state }; }
  attach(entry, guildId, selfId, profile) {
    if (this.entry === entry && this.profile === profile) return;
    this.entry = entry; this.profile = profile;
    this.owner.post({ type: 'monitorAttach', entryId: entry.workerId, guildId, selfId, profile });
  }
  stop(error = '') {
    this.entry = null; this.error = error;
    this.state = { ...this.state, id: '', guildId: '', channelId: '', status: error ? 'error' : 'waiting', users: 0, error };
    this.owner.post({ type: 'monitorStop', error }); this.owner.changed();
  }
}

class RemoteMixer {
  constructor(owner, entryId) {
    this.owner = owner; this.entryId = entryId; this.destroyed = false; this.values = {}; this.pending = {};
    for (const key of ['mediaVolume', 'ducking', 'duckFadeInMs', 'duckFadeOutMs', 'backgroundVolume']) Object.defineProperty(this, key, {
      get: () => this.values[key], set: value => { if (this.values[key] !== value) { this.values[key] = value; this.pending[key] = value; this.flushSoon(); } },
    });
    for (const [key, lane] of [['mediaGain', 'media'], ['backgroundGain', 'background']]) this[key] = { fade: (value, ms = 0, at = Date.now()) => owner.post({ type: 'fade', entryId, lane, value, ms, at }) };
  }
  flushSoon() {
    if (this.flushing) return; this.flushing = true;
    queueMicrotask(() => { this.flushing = false; if (this.destroyed) return; const values = this.pending; this.pending = {}; this.owner.post({ type: 'settings', entryId: this.entryId, values, effects: this.pendingEffects }); this.pendingEffects = undefined; });
  }
  configureEffects(config) {
    const effects = { equalizer: config.equalizer, compressor: config.compressor }, key = JSON.stringify(effects);
    if (key === this.effectsKey) return; this.effectsKey = key; this.pendingEffects = effects; this.flushSoon();
  }
  addMedia(bytes) { this.owner.post({ type: 'pcm', entryId: this.entryId, lane: 'media', bytes }); }
  addBackground(bytes) { this.owner.post({ type: 'pcm', entryId: this.entryId, lane: 'background', bytes }); }
  clearMedia() { this.owner.post({ type: 'clear', entryId: this.entryId, lane: 'media' }); }
  clearBackground() { this.owner.post({ type: 'clear', entryId: this.entryId, lane: 'background' }); }
  addSpeech(bytes, volume, signal, startAt = 0) { return this.owner.request({ method: 'speech', entryId: this.entryId, bytes, volume, startAt }, signal); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.owner.release(this.entryId); } }
  on() { return this; }
}

export class DiscordAudioWorker {
  constructor({ changed = () => {}, monitorSend = () => {}, log = () => {}, workerUrl = new URL('./voice-worker-entry.mjs', import.meta.url), workerData } = {}) {
    Object.assign(this, { changed, monitorSend, log, workerUrl, workerData }); this.entries = new Map(); this.pending = new Map(); this.monitor = new RemoteMonitor(this);
  }
  start() {
    if (this.worker) return;
    const worker = this.worker = new Worker(this.workerUrl, { workerData: this.workerData, execArgv: [] }); worker.unref();
    worker.on('message', message => { if (this.worker === worker) this.message(message); });
    worker.on('error', error => { if (this.worker === worker) this.failed(error); });
    worker.on('exit', code => { if (this.worker === worker) this.failed(new Error(`音声ワーカーが終了しました (${code})`)); });
  }
  post(message) { this.worker?.postMessage(message); }
  async health() { this.start(); return this.request({ method: 'health' }); }
  request(message, signal) {
    signal?.throwIfAborted();
    if (!this.worker) return Promise.reject(new Error('音声ワーカーが終了しました'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => { this.post({ type: 'cancel', id }); finish(signal.reason); };
      let done = false;
      const finish = (error, value) => { if (done) return; done = true; this.pending.delete(id); if (!this.pending.size) this.worker?.unref(); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(value); };
      this.pending.set(id, { finish, entryId: message.entryId }); this.worker.ref(); signal?.addEventListener('abort', abort, { once: true });
      try { this.post({ ...message, type: 'request', id }); } catch (error) { finish(error); }
    });
  }
  open({ guildId, channelId, selfDeaf, adapterCreator, networkProfile, bitrate }) {
    this.start(); const workerId = crypto.randomUUID(), connection = new EventEmitter(), player = new EventEmitter();
    connection.state = { status: 'signalling' }; connection.joinConfig = { guildId, channelId, selfDeaf };
    connection.rejoin = options => { Object.assign(connection.joinConfig, options); this.post({ type: 'rejoin', entryId: workerId, options }); return true; };
    connection.destroy = () => { this.release(workerId); connection.state = { status: 'destroyed' }; };
    player.state = { status: 'buffering', resource: { metadata: { configureNetwork: (profile, requestedBitrate) => this.post({ type: 'network', entryId: workerId, profile, bitrate: requestedBitrate }) } } };
    player.stop = () => this.release(workerId);
    const mixer = new RemoteMixer(this, workerId), entry = { workerId, connection, player, mixer, channelId }; this.entries.set(workerId, entry);
    try {
      entry.adapter = adapterCreator({
        onVoiceServerUpdate: data => this.post({ type: 'gateway', entryId: workerId, event: 'onVoiceServerUpdate', data }),
        onVoiceStateUpdate: data => this.post({ type: 'gateway', entryId: workerId, event: 'onVoiceStateUpdate', data }),
        destroy: () => queueMicrotask(() => { if (this.entries.has(workerId)) entry.player.emit('error', new Error('Discordの音声アダプターが終了しました')); }),
      });
      entry.ready = this.request({ method: 'open', entryId: workerId, guildId, channelId, selfDeaf, networkProfile, bitrate });
    } catch (error) { this.release(workerId); throw error; }
    return entry;
  }
  message(message) {
    const entry = this.entries.get(message.entryId);
    if (message.type === 'result') {
      const error = message.error ? Object.assign(new Error(message.error.message), { name: message.error.name }) : null;
      this.pending.get(message.id)?.finish(error, message.value);
    } else if (message.type === 'connectionState' && entry) {
      const before = entry.connection.state; entry.connection.state = { status: message.status };
      entry.connection.emit('stateChange', before, entry.connection.state); entry.connection.emit(message.status, before, entry.connection.state);
    } else if (message.type === 'playerState' && entry) { entry.player.state.status = message.status; }
    else if (message.type === 'failure' && entry) entry.player.emit('error', new Error(message.error));
    else if (message.type === 'connectionError' && entry) entry.connection.emit('error', new Error(message.error));
    else if (message.type === 'adapterPayload' && entry) { if (!entry.adapter.sendPayload(message.data)) { entry.player.emit('error', new Error('Discordの接続が終了しました')); } }
    else if (message.type === 'adapterDestroy' && entry) { entry.adapter.destroy(); }
    else if (message.type === 'monitor') this.monitorSend(message.message);
    else if (message.type === 'monitorState') { this.monitor.state = message.state; this.monitor.error = message.state.error; this.changed(); }
    else if (message.type === 'log') this.log(message.level, message.text);
  }
  release(id) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id); entry.mixer.destroyed = true;
    for (const [requestId, pending] of [...this.pending]) if (pending.entryId === id) { this.post({ type: 'cancel', id: requestId }); pending.finish(new DOMException('Cancelled', 'AbortError')); }
    this.post({ type: 'release', entryId: id });
    // Send leave before deleting the gateway adapter. The worker's later leave
    // packet is deliberately ignored, so an old VM cannot leave a newer VC.
    try { entry.adapter?.sendPayload({ op: 4, d: { guild_id: entry.connection.joinConfig.guildId, channel_id: null, self_mute: false, self_deaf: entry.connection.joinConfig.selfDeaf } }); }
    catch (error) { this.log('warn', `音声チャンネルの退出: ${error.message}`); }
    entry.adapter?.destroy();
  }
  failed(error) {
    const worker = this.worker; this.worker = null;
    for (const { finish } of [...this.pending.values()]) finish(error);
    for (const entry of [...this.entries.values()]) { entry.adapter?.destroy(); entry.mixer.destroyed = true; entry.player.emit('error', error); }
    this.entries.clear(); this.monitor.stop(error.message); void worker?.terminate();
  }
  close() {
    const worker = this.worker; if (!worker) return;
    for (const id of [...this.entries.keys()]) this.release(id);
    this.post({ type: 'shutdown' }); this.worker = null;
    for (const { finish } of [...this.pending.values()]) finish(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => { void worker.terminate(); }, 2000); timer.unref(); worker.once('exit', () => clearTimeout(timer));
  }
}

import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import OpusScript from './opus-codec.mjs';
import { GainEnvelope } from '../core/hourly-audio.mjs';
import { MediaEffects } from './media-effects.mjs';
import { hasHumanListeners } from '../core/voice-audience.mjs';
import { VoiceMonitor } from './voice-monitor.mjs';
import { audioNetwork } from '../core/audio-network.mjs';
import {
  joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer,
  createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus,
} from '@discordjs/voice';

export class PcmMixer extends Readable {
  constructor(profile = 'poor') {
    super({ highWaterMark: 3840 }); this.media = Buffer.alloc(0); this.speech = []; this.mediaPrimed = false;
    this.ducking = 0.35; this.mediaVolume = 0.7; this.duckGain = new GainEnvelope(); this.duckFadeInMs = 0; this.duckFadeOutMs = 0;
    this.mediaGain = new GainEnvelope(); this.background = Buffer.alloc(0); this.backgroundPrimed = false; this.backgroundVolume = 0.18; this.backgroundGain = new GainEnvelope();
    this.network = audioNetwork(profile); this.mediaEffects = new MediaEffects(); this.backgroundEffects = new MediaEffects();
    this.watchdog = setInterval(() => {
      if (this.speech.some(track => Date.now() >= (track.startAt || 0) && Date.now() - Math.max(track.progressAt, track.startAt || 0) > 10000)) this.destroy(new Error('Discord音声ストリームが停止しました。次の読み上げで再接続します'));
    }, 1000);
  }
  _read() { this.frame(); }
  addMedia(chunk) { if (!this.destroyed) this.media = Buffer.concat([this.media, chunk]).subarray(-192000); }
  clearMedia() { this.media = Buffer.alloc(0); this.mediaPrimed = false; this.mediaEffects.reset(); }
  addBackground(chunk) { if (!this.destroyed) this.background = Buffer.concat([this.background, chunk]).subarray(-192000); }
  clearBackground() { this.background = Buffer.alloc(0); this.backgroundPrimed = false; this.backgroundEffects.reset(); }
  configureEffects(c) { this.mediaEffects.configure(c.equalizer, c.compressor); this.backgroundEffects.configure(c.equalizer, c.compressor); }
  addSpeech(buffer, volume, signal, startAt = 0) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      if (this.destroyed || this.readableEnded) throw new Error('Discord音声ストリームが終了しました。次の読み上げで再接続します');
      if (!buffer.length) throw new Error('再生する音声が空です');
      const track = { buffer, position: 0, volume, resolve, reject, progressAt: Date.now(), startAt };
      track.abort = () => { this.speech = this.speech.filter(t => t !== track); reject(new DOMException('Cancelled', 'AbortError')); };
      track.signal = signal; signal?.addEventListener('abort', track.abort, { once: true }); this.speech.push(track);
    });
  }
  takeFrame(now = Date.now()) {
    if (this.destroyed) throw new Error('音声ストリームが終了しました');
    if (!this.mediaPrimed && this.media.length >= this.network.mediaMs * 192) this.mediaPrimed = true;
    if (this.mediaPrimed && this.media.length < 3840) this.mediaPrimed = false;
    const mediaReady = this.mediaPrimed;
    if (!this.backgroundPrimed && this.background.length >= this.network.mediaMs * 192) this.backgroundPrimed = true;
    if (this.backgroundPrimed && this.background.length < 3840) this.backgroundPrimed = false;
    const tracks = this.speech.filter(t => !t.startAt || now >= t.startAt);
    for (const track of tracks) if (track.startAt) track.position = Math.max(track.position, Math.floor((now - track.startAt) / 20) * 3840);
    const out = Buffer.alloc(3840); const duck = tracks.length ? this.ducking : 1;
    if (this.duckGain.to !== duck) this.duckGain.fade(duck, duck < this.duckGain.to ? this.duckFadeOutMs : this.duckFadeInMs, now);
    const mediaGain = this.mediaVolume * this.duckGain.value(now) * this.mediaGain.value(now), backgroundGain = this.backgroundVolume * this.backgroundGain.value(now);
    const mediaSamples = mediaReady ? this.mediaEffects.process(this.media.subarray(0, 3840)) : null;
    const backgroundSamples = this.backgroundPrimed ? this.backgroundEffects.process(this.background.subarray(0, 3840)) : null;
    for (let i = 0; i < 3840; i += 2) {
      let sample = mediaReady ? (mediaSamples ? mediaSamples[i / 2] : this.media.readInt16LE(i)) * mediaGain : 0;
      if (this.backgroundPrimed) sample += (backgroundSamples ? backgroundSamples[i / 2] : this.background.readInt16LE(i)) * backgroundGain;
      for (const track of tracks) if (track.position + i + 1 < track.buffer.length) sample += track.buffer.readInt16LE(track.position + i) * track.volume;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i);
    }
    if (mediaReady) this.media = this.media.subarray(3840);
    if (this.backgroundPrimed) this.background = this.background.subarray(3840);
    for (const track of tracks) {
      track.position += 3840; track.progressAt = Date.now();
      if (track.position >= track.buffer.length) {
        this.speech = this.speech.filter(t => t !== track); track.signal?.removeEventListener('abort', track.abort); track.resolve();
      }
    }
    return out;
  }
  frame() { if (!this.destroyed && this.readableLength < this.readableHighWaterMark) this.push(this.takeFrame()); }
  _destroy(error, callback) {
    clearInterval(this.watchdog);
    for (const track of this.speech) { track.signal?.removeEventListener('abort', track.abort); track.reject(error || new Error('音声接続が終了しました')); }
    this.speech = []; callback(error);
  }
}

// Generate one packet when Discord requests it. A second 20-ms producer timer drifted
// behind Discord's clock and forced the player to insert gaps under UI/IPC load.
export function createDiscordAudioResource(mixer, profile = 'poor', bitrateKbps) {
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const configureNetwork = (value, requestedBitrate) => {
    const settings = audioNetwork(value); mixer.network = settings;
    encoder.encoderCTL(4002, requestedBitrate == null ? settings.bitrate : requestedBitrate * 1000); // OPUS_SET_BITRATE
    encoder.encoderCTL(4006, 0); // CBR: bound every 20-ms packet, even during loud music.
    encoder.encoderCTL(4012, 1); // In-band FEC when the chosen Opus mode supports it.
    encoder.encoderCTL(4014, settings.lossPercent);
    encoder.encoderCTL(4016, 0); // No DTX: quiet media and silence are always transmitted.
  };
  configureNetwork(profile, bitrateKbps);
  const source = new Readable({ objectMode: true, highWaterMark: 1,
    read() { try { this.push(Buffer.from(encoder.encode(mixer.takeFrame(), 960))); } catch (e) { this.destroy(e); } },
    destroy(error, callback) { mixer.removeListener('error', failed); mixer.removeListener('close', closed); mixer.destroy(); encoder.delete(); callback(error); },
  });
  const failed = error => source.destroy(error), closed = () => source.destroy();
  mixer.on('error', failed); mixer.once('close', closed);
  return createAudioResource(source, { inputType: StreamType.Opus, metadata: { configureNetwork } });
}

export function decodeAudio(buffer, signal, executable = ffmpegPath) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable.replace('app.asar', 'app.asar.unpacked'), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let failed = false;
    const finish = (error) => { if (failed) return; failed = true; child.kill(); signal?.removeEventListener('abort', abort); reject(error); };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', finish); child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 100 * 1024 * 1024) finish(new Error('音声が長すぎます')); else chunks.push(chunk); });
    child.stderr.on('data', () => {});
    child.on('close', code => { signal?.removeEventListener('abort', abort); if (failed) return; if (code !== 0) reject(new Error('FFmpegで音声を変換できません')); else resolve(Buffer.concat(chunks)); });
    child.stdin.end(buffer);
  });
}

export class VoiceOutput {
  constructor(getClient, getConfig, log, { monitorSend = () => {}, changed = () => {} } = {}) { this.getClient = getClient; this.getConfig = getConfig; this.log = log; this.changed = changed; this.connections = new Map(); this.connecting = new Map(); this.connectionEpochs = new Map(); this.speechControllers = new Map(); this.pcmControllers = new Map(); this.heldSpeech = new Map(); this.monitor = new VoiceMonitor(monitorSend, changed, log); }
  async connect(guildId, overrideChannel, allowEmpty = false) {
    if (this.connecting.has(guildId)) return this.connecting.get(guildId);
    const epoch = this.connectionEpochs.get(guildId) || 0;
    const pending = this.establish(guildId, overrideChannel, allowEmpty, epoch); this.connecting.set(guildId, pending);
    try { return await pending; } finally { if (this.connecting.get(guildId) === pending) this.connecting.delete(guildId); }
  }
  async establish(guildId, overrideChannel, allowEmpty = false, epoch = this.connectionEpochs.get(guildId) || 0) {
    const binding = this.getConfig().bot.bindings.find(b => b.guildId === guildId);
    const channelId = overrideChannel || binding?.voiceChannelId;
    if (!channelId) throw new Error('音声チャンネルを設定してください');
    const existing = this.connections.get(guildId);
    if (existing && existing.channelId === channelId && existing.connection.state.status === VoiceConnectionStatus.Ready && !existing.mixer.destroyed && existing.player.state.status !== AudioPlayerStatus.Idle) return existing;
    this.disconnect(guildId, false);
    const client = this.getClient(); if (!client?.isReady()) throw new Error('Discord Botに接続してください');
    const channel = await client.channels.fetch(channelId);
    if ((this.connectionEpochs.get(guildId) || 0) !== epoch) throw new DOMException('Cancelled', 'AbortError');
    if (this.getClient() !== client || !client.isReady()) throw new Error('Discord接続が終了しました');
    if (!channel?.isVoiceBased() || channel.guildId !== guildId) throw new Error('指定した音声チャンネルを利用できません');
    if (!allowEmpty && this.getConfig().bot.autoLeave && hasHumanListeners(channel.guild, channelId) === false) throw new Error('人がいる音声チャンネルへ接続してください');
    const connection = joinVoiceChannel({ channelId, guildId, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: this.getConfig().desktop.voiceMonitorGuildId !== guildId });
    const mixer = new PcmMixer(this.getConfig().desktop.networkProfile); const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } });
    const entry = { connection, mixer, player, channelId }; this.connections.set(guildId, entry);
    connection.on('stateChange', () => { this.syncMonitor(); this.changed(); });
    connection.on('error', error => this.log('error', `音声接続: ${error.message}`));
    const failed = error => {
      if (this.connections.get(guildId) !== entry) return;
      this.log('error', `音声再生 (${guildId}): ${error.message}`); this.disconnect(guildId);
    };
    player.on('error', failed);
    mixer.on('error', failed);
    player.on(AudioPlayerStatus.Idle, () => failed(new Error('音声ストリームが停止しました。次の読み上げで再接続します')));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try { await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)]); }
      catch { if (this.connections.get(guildId) === entry) this.disconnect(guildId); }
    });
    try { await entersState(connection, VoiceConnectionStatus.Ready, 20000); }
    catch {
      if ((this.connectionEpochs.get(guildId) || 0) !== epoch) throw new DOMException('Cancelled', 'AbortError');
      if (this.connections.get(guildId) === entry) this.disconnect(guildId);
      throw new Error('Discord音声接続を確立できません。接続・発言権限と回線を確認してください');
    }
    if ((this.connectionEpochs.get(guildId) || 0) !== epoch || this.connections.get(guildId) !== entry) throw new DOMException('Cancelled', 'AbortError');
    try { connection.subscribe(player); player.play(createDiscordAudioResource(mixer, this.getConfig().desktop.networkProfile, this.getConfig().desktop.audioBitrateKbps)); }
    catch (error) { this.disconnect(guildId); throw error; }
    this.syncMonitor(); this.changed(); return entry;
  }
  async speech(guildId, buffer, volume, signal, priority = 0) {
    const controller = new AbortController(); const playbackSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (!this.speechControllers.has(guildId)) this.speechControllers.set(guildId, new Set());
    const controllers = this.speechControllers.get(guildId); controllers.add(controller);
    try {
      const hold = this.heldSpeech.get(guildId);
      if (hold && priority < 100) await new Promise((resolve, reject) => {
        playbackSignal.throwIfAborted();
        const resume = () => { playbackSignal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { hold.waiters.delete(resume); reject(playbackSignal.reason); };
        hold.waiters.add(resume); playbackSignal.addEventListener('abort', abort, { once: true });
      });
      const entry = await this.connect(guildId); playbackSignal.throwIfAborted();
      const pcm = await decodeAudio(buffer, playbackSignal); await entry.mixer.addSpeech(pcm, volume, playbackSignal);
    } catch (error) { if (!controller.signal.aborted || signal?.aborted) throw error; }
    finally { controllers.delete(controller); if (!controllers.size) this.speechControllers.delete(guildId); }
  }
  interruptSpeech(guildId) { for (const controller of this.speechControllers.get(guildId) || []) controller.abort(); }
  async pcm(guildId, pcm, volume, signal, startAt = 0) {
    const controller = new AbortController(), playbackSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (!this.pcmControllers.has(guildId)) this.pcmControllers.set(guildId, new Set());
    const controllers = this.pcmControllers.get(guildId); controllers.add(controller);
    try {
      const entry = await this.connect(guildId); playbackSignal.throwIfAborted();
      if (startAt && Date.now() > startAt + 250) throw new Error('時報の音声接続準備が予約時刻に間に合いませんでした');
      await entry.mixer.addSpeech(pcm, volume, playbackSignal, startAt);
    } catch (error) {
      // Leaving one empty VC must not abort the common chime in the other guilds.
      if (!controller.signal.aborted || signal?.aborted) throw error;
    } finally { controllers.delete(controller); if (!controllers.size) this.pcmControllers.delete(guildId); }
  }
  holdSpeech(guildId, value) {
    if (value) { const hold = this.heldSpeech.get(guildId) || { count: 0, waiters: new Set() }; hold.count++; this.heldSpeech.set(guildId, hold); }
    else { const hold = this.heldSpeech.get(guildId); if (hold && --hold.count === 0) { this.heldSpeech.delete(guildId); for (const resume of hold.waiters) resume(); } }
  }
  async beginMedia(guildId) { const entry = await this.connect(guildId); const c = this.getConfig(); this.mediaSettings(entry.mixer, c); return entry; }
  mediaSettings(mixer, c) { mixer.configureEffects(c.media); mixer.mediaVolume = c.media.output === 'both' ? 1 : c.media.volume; mixer.ducking = c.media.output === 'both' ? 1 : c.media.ducking; mixer.duckFadeInMs = c.media.duckFadeInMs; mixer.duckFadeOutMs = c.media.duckFadeOutMs; }
  updateSettings() { const c = this.getConfig(); for (const [id, { mixer, connection, player }] of this.connections) { this.mediaSettings(mixer, c); player?.state?.resource?.metadata?.configureNetwork(c.desktop.networkProfile, c.desktop.audioBitrateKbps); const selfDeaf = c.desktop.voiceMonitorGuildId !== id; if (connection.joinConfig.selfDeaf !== selfDeaf) connection.rejoin({ selfDeaf }); } this.syncMonitor(); }
  syncMonitor() {
    const c = this.getConfig(), guildId = c.desktop.voiceMonitorGuildId, entry = this.connections.get(guildId);
    if (entry?.connection.state.status === VoiceConnectionStatus.Ready && c.bot.bindings.some(b => b.guildId === guildId && b.voiceChannelId === entry.channelId)) this.monitor.attach(entry, guildId, this.getClient()?.user?.id, c.desktop.networkProfile);
    else if (this.monitor.entry) this.monitor.stop();
  }
  media(guildId, chunk) { const entry = this.connections.get(guildId); if (!entry) return; this.mediaSettings(entry.mixer, this.getConfig()); entry.mixer.addMedia(chunk); }
  endMedia(guildId) { this.connections.get(guildId)?.mixer.clearMedia(); }
  fadeMedia(guildId, gain, ms) { this.connections.get(guildId)?.mixer.mediaGain.fade(gain, ms); }
  async beginBackground(guildId) { const entry = await this.connect(guildId); const c = this.getConfig(); entry.mixer.configureEffects(c.media); entry.mixer.backgroundVolume = c.hourly.output === 'both' ? 1 : c.hourly.bgmVolume; entry.mixer.backgroundGain.fade(0); entry.mixer.clearBackground(); }
  background(guildId, bytes) { const mixer = this.connections.get(guildId)?.mixer; if (!mixer) return; const c = this.getConfig(); mixer.configureEffects(c.media); mixer.backgroundVolume = c.hourly.output === 'both' ? 1 : c.hourly.bgmVolume; mixer.addBackground(bytes); }
  fadeBackground(guildId, gain, ms) { this.connections.get(guildId)?.mixer.backgroundGain.fade(gain, ms); }
  endBackground(guildId) { this.connections.get(guildId)?.mixer.clearBackground(); }
  disconnect(guildId, cancelPending = true) { if (cancelPending) { this.connectionEpochs.set(guildId, (this.connectionEpochs.get(guildId) || 0) + 1); this.connecting.delete(guildId); for (const controller of this.pcmControllers.get(guildId) || []) controller.abort(); } const entry = this.connections.get(guildId); if (!entry) return; this.connections.delete(guildId); this.syncMonitor(); entry.player.stop(); entry.mixer.destroy(); if (entry.connection.state.status !== VoiceConnectionStatus.Destroyed) entry.connection.destroy(); this.changed(); }
  close() { for (const id of new Set([...this.connections.keys(), ...this.connecting.keys()])) this.disconnect(id); this.monitor.stop(); }
  snapshot() { return [...this.connections].map(([guildId, e]) => ({ guildId, channelId: e.channelId, status: e.connection.state.status })); }
}

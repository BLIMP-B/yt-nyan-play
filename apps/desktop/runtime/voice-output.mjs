import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import {
  joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer,
  createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus,
} from '@discordjs/voice';

export class PcmMixer extends Readable {
  constructor() {
    super({ highWaterMark: 3840 * 5 }); this.media = Buffer.alloc(0); this.speech = [];
    this.ducking = 0.35; this.mediaVolume = 0.7;
    this.timer = setInterval(() => this.frame(), 20);
    this.watchdog = setInterval(() => {
      if (this.speech.some(track => Date.now() - track.progressAt > 10000)) this.destroy(new Error('Discord音声ストリームが停止しました。次の読み上げで再接続します'));
    }, 1000);
  }
  _read() {}
  addMedia(chunk) { if (!this.destroyed) this.media = Buffer.concat([this.media, chunk]).subarray(-192000); }
  clearMedia() { this.media = Buffer.alloc(0); }
  addSpeech(buffer, volume, signal) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      if (this.destroyed || this.readableEnded) throw new Error('Discord音声ストリームが終了しました。次の読み上げで再接続します');
      if (!buffer.length) throw new Error('再生する音声が空です');
      const track = { buffer, position: 0, volume, resolve, reject, progressAt: Date.now() };
      track.abort = () => { this.speech = this.speech.filter(t => t !== track); reject(new DOMException('Cancelled', 'AbortError')); };
      track.signal = signal; signal?.addEventListener('abort', track.abort, { once: true }); this.speech.push(track);
    });
  }
  frame() {
    if (this.destroyed) return;
    if (this.readableLength > this.readableHighWaterMark) return;
    const out = Buffer.alloc(3840); const duck = this.speech.length ? this.ducking : 1;
    for (let i = 0; i < 3840; i += 2) {
      let sample = i + 1 < this.media.length ? this.media.readInt16LE(i) * this.mediaVolume * duck : 0;
      for (const track of this.speech) if (track.position + i + 1 < track.buffer.length) sample += track.buffer.readInt16LE(track.position + i) * track.volume;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i);
    }
    this.media = this.media.subarray(Math.min(3840, this.media.length));
    for (const track of [...this.speech]) {
      track.position += 3840; track.progressAt = Date.now();
      if (track.position >= track.buffer.length) {
        this.speech = this.speech.filter(t => t !== track); track.signal?.removeEventListener('abort', track.abort); track.resolve();
      }
    }
    this.push(out);
  }
  _destroy(error, callback) {
    clearInterval(this.timer); clearInterval(this.watchdog);
    for (const track of this.speech) { track.signal?.removeEventListener('abort', track.abort); track.reject(error || new Error('音声接続が終了しました')); }
    this.speech = []; callback(error);
  }
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
  constructor(getClient, getConfig, log) { this.getClient = getClient; this.getConfig = getConfig; this.log = log; this.connections = new Map(); this.connecting = new Map(); this.speechControllers = new Map(); this.heldSpeech = new Map(); }
  async connect(guildId, overrideChannel) {
    if (this.connecting.has(guildId)) return this.connecting.get(guildId);
    const pending = this.establish(guildId, overrideChannel); this.connecting.set(guildId, pending);
    try { return await pending; } finally { this.connecting.delete(guildId); }
  }
  async establish(guildId, overrideChannel) {
    const binding = this.getConfig().bot.bindings.find(b => b.guildId === guildId);
    const channelId = overrideChannel || binding?.voiceChannelId;
    if (!channelId) throw new Error('音声チャンネルを設定してください');
    const existing = this.connections.get(guildId);
    if (existing && existing.channelId === channelId && existing.connection.state.status === VoiceConnectionStatus.Ready && !existing.mixer.destroyed && existing.player.state.status !== AudioPlayerStatus.Idle) return existing;
    this.disconnect(guildId);
    const client = this.getClient(); if (!client?.isReady()) throw new Error('Discord Botに接続してください');
    const channel = await client.channels.fetch(channelId);
    if (this.getClient() !== client || !client.isReady()) throw new Error('Discord接続が終了しました');
    if (!channel?.isVoiceBased() || channel.guildId !== guildId) throw new Error('指定した音声チャンネルを利用できません');
    const connection = joinVoiceChannel({ channelId, guildId, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
    const mixer = new PcmMixer(); const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } });
    const entry = { connection, mixer, player, channelId }; this.connections.set(guildId, entry);
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
    catch { this.disconnect(guildId); throw new Error('Discord音声接続を確立できません。接続・発言権限と回線を確認してください'); }
    try { connection.subscribe(player); player.play(createAudioResource(mixer, { inputType: StreamType.Raw })); }
    catch (error) { this.disconnect(guildId); throw error; }
    return entry;
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
  holdSpeech(guildId, value) {
    if (value) { const hold = this.heldSpeech.get(guildId) || { count: 0, waiters: new Set() }; hold.count++; this.heldSpeech.set(guildId, hold); }
    else { const hold = this.heldSpeech.get(guildId); if (hold && --hold.count === 0) { this.heldSpeech.delete(guildId); for (const resume of hold.waiters) resume(); } }
  }
  async beginMedia(guildId) { const entry = await this.connect(guildId); const c = this.getConfig(); entry.mixer.mediaVolume = c.media.output === 'both' ? 1 : c.media.volume; entry.mixer.ducking = c.media.output === 'both' ? 1 : c.media.ducking; return entry; }
  media(guildId, chunk) { const entry = this.connections.get(guildId); if (!entry) return; const c = this.getConfig(); entry.mixer.mediaVolume = c.media.output === 'both' ? 1 : c.media.volume; entry.mixer.ducking = c.media.output === 'both' ? 1 : c.media.ducking; entry.mixer.addMedia(chunk); }
  endMedia(guildId) { this.connections.get(guildId)?.mixer.clearMedia(); }
  disconnect(guildId) { const entry = this.connections.get(guildId); if (!entry) return; this.connections.delete(guildId); entry.player.stop(); entry.mixer.destroy(); if (entry.connection.state.status !== VoiceConnectionStatus.Destroyed) entry.connection.destroy(); }
  close() { for (const id of [...this.connections.keys()]) this.disconnect(id); }
  snapshot() { return [...this.connections].map(([guildId, e]) => ({ guildId, channelId: e.channelId, status: e.connection.state.status })); }
}

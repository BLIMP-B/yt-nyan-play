import { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer, NoSubscriberBehavior, AudioPlayerStatus } from '@discordjs/voice';
import { PcmMixer, createDiscordAudioResource } from './voice-output.mjs';
import { VoiceMonitor } from './voice-monitor.mjs';
import Opus from './opus-codec.mjs';
import { threadId } from 'node:worker_threads';

// The gateway adapter crosses threads; voice WebSocket, UDP, DAVE, Opus and
// the 20-ms player clock stay together on this thread.
export class VoiceWorkerRuntime {
  constructor(port, { join = joinVoiceChannel } = {}) {
    this.port = port; this.join = join; this.entries = new Map(); this.requests = new Map();
    this.monitor = new VoiceMonitor(message => this.send({ type: 'monitor', message }), () => this.send({ type: 'monitorState', state: this.monitor.snapshot() }), (level, text) => this.send({ type: 'log', level, text }));
    port.on('message', message => this.handle(message));
  }
  send(message) { this.port.postMessage(message); }
  handle(message) {
    if (message.type === 'gateway') {
      const entry = this.entries.get(message.entryId);
      entry?.adapter?.[message.event]?.(message.data); return;
    }
    if (message.type === 'cancel') { this.requests.get(message.id)?.abort(); return; }
    if (message.type === 'release') { this.release(message.entryId); return; }
    if (message.type === 'shutdown') { for (const controller of this.requests.values()) controller.abort(); for (const id of [...this.entries.keys()]) this.release(id); this.monitor.stop(); this.port.close(); return; }
    if (message.type === 'request') {
      const controller = new AbortController(); this.requests.set(message.id, controller);
      void this.command(message, controller.signal).then(value => this.send({ type: 'result', id: message.id, value }), error => this.send({ type: 'result', id: message.id, error: { name: error.name, message: error.message } })).finally(() => this.requests.delete(message.id));
      return;
    }
    try { this.control(message); }
    catch (error) { this.send({ type: 'failure', entryId: message.entryId, error: error.message }); }
  }
  async command(message, signal) {
    if (message.method === 'health') {
      const mixer = new PcmMixer(), resource = createDiscordAudioResource(mixer), decoder = new Opus();
      try { const packet = resource.playStream.read(); return { threadId, packetBytes: packet.length, pcmBytes: decoder.decode(packet).length }; }
      finally { resource.playStream.destroy(); mixer.destroy(); decoder.delete(); }
    }
    if (message.method === 'open') {
      const { entryId, guildId, channelId, selfDeaf, networkProfile, bitrate } = message;
      const mixer = new PcmMixer(networkProfile), player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } });
      const entry = { mixer, player, channelId }; this.entries.set(entryId, entry);
      try {
        entry.connection = this.join({ guildId, channelId, selfDeaf, adapterCreator: methods => {
          entry.adapter = methods;
          return { sendPayload: data => { this.send({ type: 'adapterPayload', entryId, data }); return true; }, destroy: () => this.send({ type: 'adapterDestroy', entryId }) };
        } });
        const connection = entry.connection;
        connection.on('stateChange', (before, after) => this.send({ type: 'connectionState', entryId, status: after.status }));
        connection.on('error', error => this.send({ type: 'connectionError', entryId, error: error.message }));
        const failed = error => this.send({ type: 'failure', entryId, error: error.message });
        player.on('error', failed); mixer.on('error', failed);
        player.on('stateChange', (_before, after) => this.send({ type: 'playerState', entryId, status: after.status }));
        player.on(AudioPlayerStatus.Idle, () => { if (this.entries.get(entryId) === entry) failed(new Error('音声ストリームが停止しました。次の読み上げで再接続します')); });
        const aborted = () => this.release(entryId); signal.addEventListener('abort', aborted, { once: true });
        try { await entersState(connection, VoiceConnectionStatus.Ready, AbortSignal.any([signal, AbortSignal.timeout(20000)])); signal.throwIfAborted(); }
        finally { signal.removeEventListener('abort', aborted); }
        if (this.entries.get(entryId) !== entry) throw new DOMException('Cancelled', 'AbortError');
        connection.subscribe(player); player.play(createDiscordAudioResource(mixer, networkProfile, bitrate));
        return { status: connection.state.status };
      } catch (error) { this.release(entryId); throw error; }
    }
    const entry = this.entries.get(message.entryId);
    if (!entry) throw new Error('Discordの音声接続が終了しました');
    if (message.method === 'speech') return entry.mixer.addSpeech(Buffer.from(message.bytes), message.volume, signal, message.startAt);
    throw new Error('Unknown audio worker request');
  }
  control(message) {
    if (message.type === 'monitorStop') { this.monitor.stop(message.error); return; }
    const entry = this.entries.get(message.entryId); if (!entry) return;
    if (message.type === 'pcm') {
      const bytes = Buffer.from(message.bytes);
      if (message.lane === 'background') entry.mixer.addBackground(bytes); else entry.mixer.addMedia(bytes);
    } else if (message.type === 'settings') {
      Object.assign(entry.mixer, message.values);
      if (message.effects) entry.mixer.configureEffects(message.effects);
    } else if (message.type === 'network') entry.player.state.resource?.metadata?.configureNetwork(message.profile, message.bitrate);
    else if (message.type === 'clear') { if (message.lane === 'background') entry.mixer.clearBackground(); else entry.mixer.clearMedia(); }
    else if (message.type === 'fade') entry.mixer[message.lane === 'background' ? 'backgroundGain' : 'mediaGain'].fade(message.value, message.ms, message.at);
    else if (message.type === 'rejoin') entry.connection.rejoin(message.options);
    else if (message.type === 'monitorAttach') this.monitor.attach(entry, message.guildId, message.selfId, message.profile);
  }
  release(id) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id);
    if (this.monitor.entry === entry) this.monitor.stop();
    entry.player.stop(true); entry.mixer.destroy();
    if (entry.connection && entry.connection.state.status !== VoiceConnectionStatus.Destroyed) entry.connection.destroy();
  }
}

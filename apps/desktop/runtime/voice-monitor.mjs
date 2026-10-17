import OpusScript from './opus-codec.mjs';
import { EndBehaviorType } from '@discordjs/voice';
import { audioNetwork } from '../core/audio-network.mjs';

// Decode on arrival; the PC audio device, not a Node timer, clocks playout.
// Keep speakers separate until the worklet so one late speaker cannot mute another.
export class VoiceMonitor {
  constructor(send, changed, log) { this.send = send; this.changed = changed; this.log = log; this.users = new Map(); this.error = ''; this.network = audioNetwork(); }
  snapshot() { return { id: this.id || '', guildId: this.guildId || '', channelId: this.entry?.channelId || '', status: this.entry ? 'listening' : this.error ? 'error' : 'waiting', users: this.users.size, rendererMs: this.network.receiveMs + this.network.rendererMs, error: this.error }; }
  attach(entry, guildId, selfId, profile = 'poor') {
    if (this.entry === entry && this.profile === profile) return;
    this.stop(); this.profile = profile; this.network = audioNetwork(profile); this.error = ''; this.entry = entry; this.guildId = guildId; this.selfId = selfId; this.id = crypto.randomUUID();
    this.onSpeaking = userId => this.receive(userId);
    entry.connection.receiver.speaking.on('start', this.onSpeaking);
    this.send({ type: 'start', id: this.id, rendererMs: this.snapshot().rendererMs }); this.changed();
    for (const userId of entry.connection.receiver.speaking.users.keys()) this.receive(userId);
  }
  receive(userId) {
    if (!this.entry || userId === this.selfId) return;
    const old = this.users.get(userId);
    if (old && !old.ended) return;
    if (old) this.remove(userId);
    if (this.users.size >= 32) { if (!this.limitReported) { this.limitReported = true; this.log('warn', 'PC通話モニターは同時32人まで受信します'); } return; }
    let decoder, stream;
    try {
      decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
      stream = this.entry.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
    } catch (error) { decoder?.delete(); this.log('warn', `通話音声の受信: ${error.message}`); return; }
    const user = { decoder, stream, streamId: crypto.randomUUID() }; this.users.set(userId, user);
    stream.on('data', packet => {
      if (this.users.get(userId) !== user) return;
      try {
        clearTimeout(user.idleTimer);
        this.send({ type: 'pcm', id: this.id, userId, streamId: user.streamId, bytes: Buffer.from(decoder.decode(packet)) });
        // A short utterance may be smaller than the jitter target. Decide that
        // it is idle on the receiver's wall clock, not a device's render-ahead
        // clock, which can advance in a burst when a Windows sink wakes up.
        user.idleTimer = setTimeout(() => { if (this.users.get(userId) === user) this.send({ type: 'idle', id: this.id, userId, streamId: user.streamId }); }, this.network.receiveMs + this.network.rendererMs);
        user.idleTimer.unref?.();
      }
      catch (error) { this.log('warn', `通話音声のデコード: ${error.message}`); this.remove(userId); }
    });
    stream.on('error', error => { if (this.users.get(userId) !== user) return; this.log('warn', `通話音声の受信: ${error.message}`); this.remove(userId); });
    stream.once('close', () => { if (this.users.get(userId) === user) this.remove(userId); });
    this.changed();
  }
  remove(userId) {
    const user = this.users.get(userId); if (!user) return;
    this.users.delete(userId);
    clearTimeout(user.idleTimer);
    this.send({ type: 'end', id: this.id, userId, streamId: user.streamId });
    // Retire first: late close/error events cannot remove a successor.
    try { user.stream.destroy(); } catch (error) { this.log('warn', `通話音声の終了: ${error.message}`); }
    try { user.decoder.delete(); } catch (error) { this.log('warn', `通話デコーダーの終了: ${error.message}`); }
    this.changed();
  }
  stop(error = '') {
    this.entry?.connection.receiver.speaking.removeListener('start', this.onSpeaking);
    this.entry = null; for (const id of this.users.keys()) this.remove(id);
    if (this.id) this.send({ type: 'stop', id: this.id });
    this.id = ''; this.guildId = ''; this.error = error; this.limitReported = false; this.changed();
  }
}

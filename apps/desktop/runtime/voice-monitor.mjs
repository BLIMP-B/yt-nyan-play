import OpusScript from 'opusscript';
import { EndBehaviorType } from '@discordjs/voice';

// One local-only receiver. No received PCM ever enters the Discord send mixer.
export class VoiceMonitor {
  constructor(send, changed, log) { this.send = send; this.changed = changed; this.log = log; this.users = new Map(); this.error = ''; }
  snapshot() { return { id: this.id || '', guildId: this.guildId || '', channelId: this.entry?.channelId || '', status: this.entry ? 'listening' : this.error ? 'error' : 'waiting', users: this.users.size, error: this.error }; }
  attach(entry, guildId, selfId) {
    if (this.entry === entry) return;
    this.stop(); this.error = ''; this.entry = entry; this.guildId = guildId; this.selfId = selfId; this.id = crypto.randomUUID();
    this.onSpeaking = userId => this.receive(userId);
    entry.connection.receiver.speaking.on('start', this.onSpeaking);
    this.send({ type: 'start', id: this.id }); this.changed();
    for (const userId of entry.connection.receiver.speaking.users.keys()) this.receive(userId);
    this.timer = setInterval(() => this.send({ type: 'pcm', id: this.id, bytes: Buffer.concat([this.frame(), this.frame()]) }), 40);
    this.timer.unref();
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
    const user = { decoder, stream, bytes: Buffer.alloc(0), primed: false, ended: false, progressAt: Date.now() }; this.users.set(userId, user);
    stream.on('data', packet => {
      if (this.users.get(userId) !== user) return;
      try {
        const pcm = Buffer.from(decoder.decode(packet));
        user.bytes = Buffer.concat([user.bytes, pcm]).subarray(-96000); user.progressAt = Date.now();
      } catch (error) { this.log('warn', `通話音声のデコード: ${error.message}`); this.remove(userId); }
    });
    stream.on('error', error => { this.log('warn', `通話音声の受信: ${error.message}`); this.remove(userId); });
    stream.once('close', () => { if (this.users.get(userId) === user) { user.ended = true; this.changed(); } });
    this.changed();
  }
  frame() {
    const mixed = new Int32Array(1920);
    for (const [userId, user] of this.users) {
      if (user.ended && !user.bytes.length || Date.now() - user.progressAt > 3000) { this.remove(userId); continue; }
      if (!user.primed && (user.bytes.length >= 15360 || user.ended)) user.primed = true;
      if (!user.primed) continue;
      const length = Math.min(3840, user.bytes.length);
      for (let i = 0; i + 1 < length; i += 2) mixed[i / 2] += user.bytes.readInt16LE(i);
      user.bytes = user.bytes.subarray(length);
      if (!user.bytes.length) user.primed = false;
    }
    const frame = Buffer.alloc(3840);
    for (let i = 0; i < mixed.length; i++) frame.writeInt16LE(Math.max(-32768, Math.min(32767, mixed[i])), i * 2);
    return frame;
  }
  remove(userId) {
    const user = this.users.get(userId); if (!user) return;
    this.users.delete(userId); user.stream.destroy(); user.decoder.delete(); this.changed();
  }
  stop(error = '') {
    clearInterval(this.timer); this.entry?.connection.receiver.speaking.removeListener('start', this.onSpeaking);
    this.entry = null; for (const id of this.users.keys()) this.remove(id);
    if (this.id) this.send({ type: 'stop', id: this.id });
    this.id = ''; this.guildId = ''; this.error = error; this.limitReported = false; this.changed();
  }
}

export const PCM_RATE = 48000, PCM_FRAME = 3840, PCM_BYTES_MS = 192;
export class GainEnvelope {
  constructor(value = 1, now = Date.now) { this.now = now; this.from = this.to = value; this.began = 0; this.duration = 0; }
  value(time = this.now()) { return this.duration ? this.from + (this.to - this.from) * Math.max(0, Math.min(1, (time - this.began) / this.duration)) : this.to; }
  fade(value, ms = 0, time = this.now()) { this.from = this.value(time); this.to = Math.max(0, Math.min(1, value)); this.began = time; this.duration = Math.max(0, ms); }
}
export function pcmWav(pcm) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(PCM_RATE, 24);
  header.writeUInt32LE(PCM_RATE * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function fourPointPcm() {
  const pcm = Buffer.alloc(PCM_RATE * 4 * 5);
  for (const [second, frequency, length] of [[0, 440, 0.1], [1, 440, 0.1], [2, 440, 0.1], [3, 880, 2]]) {
    for (let i = 0; i < PCM_RATE * length; i++) {
      const envelope = Math.min(1, i / 96, (PCM_RATE * length - i) / (length === 2 ? PCM_RATE * 0.8 : 96));
      const sample = Math.round(Math.sin(2 * Math.PI * frequency * i / PCM_RATE) * 9000 * envelope);
      const offset = (second * PCM_RATE + i) * 4; pcm.writeInt16LE(sample, offset); pcm.writeInt16LE(sample, offset + 2);
    }
  }
  return pcm;
}
export function hourlyProgram(announcementPcm, hourAt) {
  const gap = Buffer.alloc(250 * PCM_BYTES_MS), beeps = fourPointPcm();
  const fourthOffsetMs = announcementPcm.length / PCM_BYTES_MS + 250 + 3000;
  return { pcm: Buffer.concat([announcementPcm, gap, beeps]), startAt: hourAt - fourthOffsetMs, fourthOffsetMs, fourthAt: hourAt };
}
export function nextHour(time = Date.now()) { const date = new Date(time); date.setMinutes(0, 0, 0); date.setHours(date.getHours() + 1); return date.getTime(); }
export function hourPhrase(hourAt) { return `にゃんとーくが${new Date(hourAt).getHours()}時をお知らせします`; }

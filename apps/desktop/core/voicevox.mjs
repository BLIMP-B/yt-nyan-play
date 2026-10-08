export const ZUNDAMON_STYLES = ['ノーマル', 'あまあま', 'ツンツン', 'セクシー', 'ささやき', 'ヒソヒソ', 'ヘロヘロ', 'なみだめ'];

export class Voicevox {
  constructor(baseUrl, fetcher = fetch) { this.baseUrl = baseUrl.replace(/\/$/, ''); this.fetcher = fetcher; }
  async request(path, options = {}, signal) {
    const timeout = AbortSignal.timeout(60000);
    const response = await this.fetcher(`${this.baseUrl}${path}`, { ...options, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    if (!response.ok) throw new Error(`VOICEVOXの応答を確認してください (HTTP ${response.status})`);
    return response;
  }
  async speakers(signal) { return (await this.request('/speakers', {}, signal)).json(); }
  async validateZundamon(signal) {
    const speakers = await this.speakers(signal);
    const speaker = speakers.find(s => s.name === 'ずんだもん');
    const styles = speaker?.styles?.filter(s => !s.type || s.type === 'talk') || [];
    const missing = ZUNDAMON_STYLES.filter(name => !styles.some(s => s.name === name));
    return { styles, missing, available: missing.length === 0 };
  }
  async synthesize(text, options, signal) {
    const query = await (await this.request(`/audio_query?${new URLSearchParams({ text, speaker: String(options.styleId) })}`, { method: 'POST' }, signal)).json();
    query.speedScale = options.speed; query.pitchScale = options.pitch;
    query.intonationScale = options.intonation; query.volumeScale = 1;
    const audio = await this.request(`/synthesis?${new URLSearchParams({ speaker: String(options.styleId) })}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
    }, signal);
    const buffer = Buffer.from(await audio.arrayBuffer());
    if (buffer.length > 30 * 1024 * 1024 || buffer.subarray(0, 4).toString() !== 'RIFF') throw new Error('音声エンジンから有効なWAVを取得できません');
    return buffer;
  }
}

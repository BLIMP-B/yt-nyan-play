import { educationKey } from '../core/education.mjs';
export class ChatEducation {
  constructor(store, native = () => null) { this.store = store; this.native = native; }
  async apply(command) {
    const native = this.native();
    if (native) {
      const args = command.type === 'Study' ? `${command.source}=${command.reading}` : command.source;
      const result = await native.learn(command.type, args);
      const config = this.store.exportConfig(), key = educationKey(command.source);
      const remaining = config.education.filter(e => educationKey(e.source) !== key);
      if (remaining.length !== config.education.length) { config.education = remaining; this.store.updateConfig(config); }
      return result;
    }
    const { source, reading } = command; let { type } = command;
    if (type !== 'Forget' && (source.length < 2 || reading.length > 15)) throw new Error('教育は単語2文字以上、読み方15文字以内で指定してください');
    const config = this.store.exportConfig(), key = educationKey(source);
    if (type === 'Study' && key === educationKey(reading)) type = 'Forget';
    const existing = config.education.some(e => educationKey(e.source) === key);
    if (type === 'Forget' && !existing) throw new Error(`${source}は教育辞書に登録されていません`);
    config.education = config.education.filter(e => educationKey(e.source) !== key);
    if (type !== 'Forget') config.education.push({ source, reading: type === 'Mute' ? '' : reading });
    this.store.updateConfig(config);
    return { text: type === 'Forget' ? `${source} を 忘れました` : type === 'Mute' ? `${source} を 無音にしました` : `${source} わ ${reading} を 覚えました` };
  }
}

import { normalizeConfig, validateMediaUrl } from '../core/config.mjs';
import { educationKey, validateEducationLength } from '../core/education.mjs';
import { readingKey, readingSource, readingSlots, setSharedReading } from '../core/shared-readings.mjs';
export class ChatEducation {
  constructor(store, native = () => null, nativeSync = native) {
    this.store = store; this.native = native; this.nativeSync = nativeSync; this.tail = Promise.resolve();
  }
  serialize(operation) {
    const task = this.tail.catch(() => {}).then(operation); this.tail = task; return task;
  }
  apply(command, options = {}) { return this.serialize(() => this.edit(command, options)); }
  set(source, reading) { return this.apply({ type: reading ? 'Study' : 'Mute', source, reading }, { settings: true }); }
  forget(source) { return this.apply({ type: 'Forget', source, reading: '' }, { settings: true }); }
  async edit(command, { settings = false, signal, native: override } = {}) {
    signal?.throwIfAborted();
    const config = this.store.exportConfig(), undo = [];
    try {
      const result = await this.change(config, command, { settings, signal, native: override, undo });
      const current = this.store.exportConfig();
      current.education = config.education; current.speech.emojiReadings = config.speech.emojiReadings; current.mediaConversions = config.mediaConversions;
      this.store.updateConfig(current); return result;
    } catch (error) { await this.rollback(undo, error); }
  }
  async rollback(undo, error) {
    const failures = [];
    for (const restore of undo.reverse()) try { await restore(); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error, ...failures], '読み方の変更に失敗し、元の教育辞書の復元にも失敗しました');
    throw error;
  }
  async change(config, command, { settings = false, signal, native: override, undo = [] } = {}) {
    if (typeof command.source !== 'string' || command.reading !== undefined && typeof command.reading !== 'string') throw new Error('教育する単語・読み方を確認してください');
    let source = readingSource(command.source), reading = command.reading || '', type = command.type;
    if (!source || source.length > 2000 || reading.length > 500 || /[\t\r\n]/u.test(source + reading) || !['Study', 'Mute', 'Forget', 'Convert'].includes(type)) throw new Error('教育する単語・読み方を確認してください');
    const existing = readingSlots(config).find(e => readingKey(e.source) === readingKey(source));
    const conversions = config.mediaConversions || [], converted = conversions.some(e => readingKey(e.source) === readingKey(source));
    const withoutConversion = () => conversions.filter(e => readingKey(e.source) !== readingKey(source));
    if (type === 'Convert') {
      validateEducationLength(source, '');
      if (typeof command.url !== 'string' || command.url.length > 2000 || /[\t\r\n]/u.test(command.url)) throw new Error('変換先のメディアURLを確認してください');
      const url = validateMediaUrl(command.url.trim(), config.media.allowedHosts);
      config.mediaConversions = withoutConversion().concat({ source, url });
      return { text: `${source} を 直接再生する変換を覚えました` };
    }
    if (type === 'Forget' && converted && !existing) {
      config.mediaConversions = withoutConversion(); return { text: `${source} の変換を忘れました` };
    }
    if (!settings && type === 'Study' && readingKey(source) === educationKey(reading)) type = 'Forget';
    if (type !== 'Forget') validateEducationLength(source, reading);
    let processor = override || (existing?.native ? this.nativeSync() : this.native());
    if (existing?.native && !processor) throw new Error('取り込んだ棒読みちゃんの教育辞書を接続してから読み方を変更してください');
    const nativeSlot = processor?.lookup ? await processor.lookup(source, signal) : null;
    // A new metadata-only setting must not turn unrelated body text or a Sound
    // path into an educated word. An existing native word keeps its scope.
    const metadataOnly = settings && (!existing || existing.metadataOnly) && !nativeSlot?.registered;
    const syncNative = processor && (type === 'Forget'
      ? nativeSlot?.registered || nativeSlot === null && (!existing || !existing.metadataOnly)
      : existing?.native || nativeSlot?.registered || !metadataOnly);
    if (type === 'Forget' && !existing && !nativeSlot?.registered && !syncNative) throw new Error(`${source}は教育辞書に登録されていません`);
    let response;
    if (syncNative) {
      response = await processor.learn(type, type === 'Study' ? `${source}=${reading}` : source, signal);
      const previous = nativeSlot || (existing?.native ? { registered: true, source: existing.source, reading: existing.reading } : null);
      // Restoring an imported value must not apply the new-registration limit.
      const restore = processor.restore?.bind(processor) || processor.learn.bind(processor);
      if (previous?.registered) undo.push(() => restore(previous.reading ? 'Study' : 'Mute', previous.reading ? `${previous.source || source}=${previous.reading}` : previous.source || source));
      else if (previous && !response.forgot) undo.push(() => processor.learn('Forget', response.source || source));
      source = response.source || source; reading = response.reading ?? reading;
      if (response.forgot) type = 'Forget';
    }
    setSharedReading(config, { source, reading: type === 'Mute' ? '' : reading, forget: type === 'Forget', metadataOnly, emoji: settings || existing?.emoji, native: Boolean(syncNative && type !== 'Forget') });
    if (type === 'Forget') config.mediaConversions = withoutConversion();
    return response || { text: type === 'Forget' ? `${source} を 忘れました` : type === 'Mute' ? `${source} を 無音にしました` : `${source} わ ${reading} を 覚えました` };
  }
  applyTag(type, args, signal, native) {
    const separator = args.search(/[=＝]/u);
    if (type === 'Study' && separator < 0) return Promise.reject(new Error('教育の単語と読み方を確認してください'));
    return this.apply({ type, source: type === 'Study' ? args.slice(0, separator) : args,
      reading: type === 'Study' ? args.slice(separator + 1) : '' }, { signal, native });
  }
  saveConfig(data, commit) {
    return this.serialize(async () => {
      const current = this.store.exportConfig(), baseline = data.__readingBase ? normalizeConfig(data.__readingBase) : current;
      const incoming = normalizeConfig(data, baseline), before = new Map(readingSlots(baseline).map(e => [readingKey(e.source), e])), after = new Map(readingSlots(incoming).map(e => [readingKey(e.source), e]));
      // Apply only edits relative to the UI snapshot, keeping chat education
      // received after that snapshot while an unrelated form was being saved.
      const working = { ...incoming, education: current.education, mediaConversions: current.mediaConversions, speech: { ...incoming.speech, emojiReadings: current.speech.emojiReadings } };
      const undo = [];
      try {
        for (const key of new Set([...before.keys(), ...after.keys()])) {
          const old = before.get(key), next = after.get(key);
          if (JSON.stringify(old) === JSON.stringify(next)) continue;
          await this.change(working, { type: next ? (next.reading ? 'Study' : 'Mute') : 'Forget', source: (next || old).source, reading: next?.reading || '' }, { settings: Boolean((next || old).metadataOnly || (next || old).emoji), undo });
        }
        const oldConversions = new Map(baseline.mediaConversions.map(e => [readingKey(e.source), e])), newConversions = new Map(incoming.mediaConversions.map(e => [readingKey(e.source), e]));
        for (const key of new Set([...oldConversions.keys(), ...newConversions.keys()])) {
          const old = oldConversions.get(key), next = newConversions.get(key);
          if (JSON.stringify(old) === JSON.stringify(next)) continue;
          if (next) await this.change(working, { type: 'Convert', ...next });
          else working.mediaConversions = working.mediaConversions.filter(e => readingKey(e.source) !== key);
        }
        return await commit(normalizeConfig(working));
      } catch (error) { await this.rollback(undo, error); }
    });
  }
}

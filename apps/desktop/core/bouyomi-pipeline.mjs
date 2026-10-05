export function nativeSegments(result) {
  if (result.parts) return result.parts.flatMap(text => text.startsWith('(') && !text.startsWith('(Ｔ ') ? [] : nativeSegments({ text, tags: result.tags }));
  const segments = [], tags = result.tags || []; let position = 0;
  for (const match of result.text.matchAll(/\(Ｔ ([０-９]+)\)/g)) {
    if (match.index > position) segments.push({ kind: 'text', text: result.text.slice(position, match.index) });
    const id = Number(match[1].replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xff10))) - 1;
    if (tags[id]) segments.push({ kind: 'tag', ...tags[id] });
    position = match.index + match[0].length;
  }
  if (position < result.text.length) segments.push({ kind: 'text', text: result.text.slice(position) });
  return segments;
}
export function nativeSpeed(settings, pendingCharacters) {
  if (settings.SpeedUpEnable !== 'true' || settings.BroadcasterMode !== 'true') return Number(settings.Speed) || 100;
  const excess = Math.max(0, pendingCharacters - Number(settings.SpeedUpStartCount));
  return Math.min(Number(settings.SpeedUpMax), Math.max(Number(settings.SpeedUpMin), Math.floor(excess / Number(settings.SpeedUpRate) * 100) + Number(settings.SpeedUpMin)));
}
const clamp = (value, min, max) => Math.min(Number(max), Math.max(Number(min), value));
export function nativeTagSettings(tag, settings, original) {
  const next = { ...settings }; const n = Number(tag.args);
  if (tag.type === 'Speed' && original.SpeedTag === 'true' && Number.isInteger(n)) next.speed = clamp(Math.trunc(clamp(n, original.SpeedMin, original.SpeedMax) * (settings.nativeBaseSpeed ?? settings.speed)), 50, 300) / 100;
  if (tag.type === 'Tone' && original.ToneTag === 'true' && Number.isInteger(n)) next.pitch = Math.log2(clamp(Math.trunc(clamp(n, original.ToneMin, original.ToneMax) * (settings.nativeBaseTone ?? 100) / 100), 50, 200) / 100);
  if (tag.type === 'Volume' && original.VolumeTag === 'true') {
    const gains = tag.args.trim().split(/\s+/).map(Number);
    if (gains.length > 2 || gains.some(v => !Number.isFinite(v))) throw new Error('Volumeタグの指定を確認してください');
    if (gains.length === 2 && gains[0] !== gains[1]) throw new Error('左右別のVolumeタグは対応待ちです');
    next.volume = Math.trunc(clamp(gains[0], original.VolumeMin, original.VolumeMax) * (settings.nativeBaseVolume ?? settings.volume)) / 100;
  }
  if (tag.type === 'Voice' && original.VoiceTag === 'true' && Number.isInteger(n)) {
    const voiceId = n >= 9 && n <= 999 ? n + 9992 : n;
    const banned = original.VoiceBanned?.int || []; if ((Array.isArray(banned) ? banned : [banned]).some(v => Number(v) === voiceId)) return next;
    const mapping = settings.bouyomiVoiceMap.find(p => p.voiceId === voiceId);
    if (!mapping) throw new Error(`棒読みちゃんの声ID ${voiceId} に対応するVOICEVOX声種を設定JSONのbouyomiVoiceMapで指定してください`);
    next.styleId = mapping.styleId;
  }
  return next;
}

export async function runNativeSpeech({ text, settings, original, pendingCharacters, processor, output, sound, log }, signal) {
  const source = { ...original, BroadcasterMode: settings.bouyomiTagMode === 'original' ? original.BroadcasterMode : String(settings.bouyomiTagMode === 'on') };
  let current = { ...settings };
  if (settings.bouyomiUseDefaults) current = { ...current, speed: nativeSpeed(source, pendingCharacters) / 100, volume: Number(source.Volume) / 100, pitch: Math.log2(Number(source.Tone) / 100) };
  current = { ...current, nativeBaseSpeed: current.speed, nativeBaseVolume: current.volume, nativeBaseTone: settings.bouyomiUseDefaults ? Number(source.Tone) : 2 ** current.pitch * 100 };
  let input = text;
  if (source.TextLengthEnable === 'true' && input.length > Number(source.TextLengthNum)) input = input.slice(0, Number(source.TextLengthNum)) + (source.TextLengthAdd || '');
  const result = await processor.process(input, settings.bouyomiTagMode, signal), parallel = [];
  try {
    for (const segment of nativeSegments(result)) {
      signal.throwIfAborted();
      if (segment.kind === 'text') { if (segment.text.trim()) await output(segment.text, current, signal); continue; }
      if (source[`${segment.type.replace(/W$/, '')}Tag`] !== 'true') continue;
      if (['Voice', 'Speed', 'Tone', 'Volume'].includes(segment.type)) { current = nativeTagSettings(segment, current, source); continue; }
      if (segment.type === 'Study' || segment.type === 'Forget') {
        const learned = await processor.learn(segment.type, segment.args, signal);
        if (learned.text) { const response = await processor.process(learned.text, 'off', signal); await output(response.text, current, signal); }
      } else if (segment.type === 'Sound' || segment.type === 'SoundW') {
        const playing = sound(segment.args, current, source, signal);
        if (segment.type === 'SoundW') await playing; else { parallel.push(playing); playing.catch(() => {}); }
      } else if (segment.type === 'Info' && segment.args.trim().toUpperCase() === 'VERSION') await output('0.1.11.0 Beta21', current, signal);
      else throw new Error(`${segment.type}タグのVOICEVOX出力への移植は対応待ちです`);
    }
    await Promise.all(parallel);
  } catch (error) { log?.('error', error.message); throw error; }
}

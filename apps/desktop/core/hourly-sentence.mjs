export const SENTENCE_PRESETS = {
  brief: { label: 'ひとこと', min: 15, max: 40 },
  short: { label: '短文', min: 40, max: 70 },
  medium: { label: '標準', min: 70, max: 110 },
  long: { label: '長め', min: 110, max: 160 },
  extended: { label: '長文', min: 160, max: 200 },
};
export function sentencePlan(config, nouns, random = Math.random) {
  const choices = Object.keys(SENTENCE_PRESETS), preset = config.sentenceStyle === 'random' ? choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))] : config.sentenceStyle || 'brief';
  const style = SENTENCE_PRESETS[preset]; if (!style) throw new Error('時報の文体を選択してください');
  const maxChars = Math.min(config.sentenceMaxChars || 200, 200);
  const targetChars = Math.min(maxChars, Math.round(style.min + random() * (style.max - style.min)));
  // The two nouns, particles, shortest allowed verb and clause separator.
  const estimate = nouns.reduce((sum, word) => sum + [...word].length, 0) + 6;
  return { preset, targetChars, maxChars, clauseCount: preset === 'brief' ? 1 : Math.max(1, Math.min(20, Math.round((targetChars - 3) / estimate))) };
}
export function sentenceFromClauses(clauses, plan) {
  let text = '';
  for (const clause of clauses) {
    const sentence = `${clause.adjective}${clause.subject}は、${clause.object}を${clause.verb}`;
    const next = text ? text + '。' + sentence : sentence;
    if ([...next + 'のだ。'].length > plan.maxChars) break;
    text = next;
  }
  if (!text) throw new Error('資料の名詞が長すぎます。文章の文字数上限を増やしてください');
  return text + 'のだ。';
}

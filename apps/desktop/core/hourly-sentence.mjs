export const SENTENCE_VERSION = 2;
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
  return { preset, targetChars, maxChars, clauseCount: preset === 'brief' ? 1 : Math.max(2, Math.min(10, Math.ceil(targetChars / 20))), version: SENTENCE_VERSION };
}
export const VERBS = [
  ['運ぶ', '運び'], ['眺める', '眺め'], ['食べる', '食べ'], ['描く', '描き'], ['集める', '集め'],
  ['見つける', '見つけ'], ['照らす', '照らし'], ['覚える', '覚え'], ['作る', '作り'], ['調べる', '調べ'],
];
const reports = [['という話を思い出す', 'という話を思い出し'], ['という出来事を確かめる', 'という出来事を確かめ'], ['という噂を聞く', 'という噂を聞き'], ['という情景を思い描く', 'という情景を思い描き'], ['という知らせを受け止める', 'という知らせを受け止め']];
const chars = text => [...text].length;
function body(unit, verb, index, final) {
  if (unit.kind === 'sentence') return `「${unit.text}」${reports[index % reports.length][final ? 0 : 1]}`;
  return `${unit.text}を${VERBS[verb][final ? 0 : 1]}`;
}
export function composeSentence(subject, parts) {
  if (!parts.length) throw new Error('文章に使える異なる資料が足りません');
  return `${subject}は、${parts.map((p, i) => body(p.unit, p.verb, i, i === parts.length - 1)).join('、')}のだ。`;
}
// SLM orders source units. Repair repeated choices with unused source material,
// not retries or padding. Shared subject + inflected predicates form one sentence.
export function assembleSentence(subject, candidates, choices, plan) {
  const selected = [], usedUnits = new Set(), usedNouns = new Set([subject]), usedWords = new Set([subject]), usedKinds = new Set(), usedSources = new Set(), usedVerbs = new Set();
  let previousWords = new Set();
  const fits = (unit, verb) => chars(composeSentence(subject, [...selected, { unit, verb }])) <= Math.min(plan.maxChars, plan.targetChars + 8);
  for (let step = 0; step < 12; step++) {
    const requested = choices[step % choices.length], preferred = candidates[requested.i];
    const unusedVerb = Array.from({ length: VERBS.length }, (_, i) => (requested.v + i) % VERBS.length).find(i => !usedVerbs.has(i) && !usedWords.has(VERBS[i][0]));
    const verb = unusedVerb ?? requested.v;
    const pool = candidates.filter(u => !usedUnits.has(`${u.kind}:${u.text}`) && u.nouns.every(n => !usedNouns.has(n)) && !u.words.some(w => previousWords.has(w)) && (u.kind === 'sentence' || unusedVerb !== undefined) && fits(u, verb));
    if (!pool.length) break;
    const remaining = plan.targetChars - chars(selected.length ? composeSentence(subject, selected) : `${subject}は、のだ。`);
    const span = unit => plan.preset !== 'brief' && remaining > 35 ? Math.min(32, chars(body(unit, verb, selected.length, true))) / 2 : 0;
    const score = unit => (unit === preferred ? 3 : 0) + (!usedKinds.has(unit.kind) ? 8 : 0) + (unit.source && !usedSources.has(unit.source) ? 4 : 0) + span(unit) - unit.words.filter(w => usedWords.has(w)).length * 4;
    pool.sort((a, b) => score(b) - score(a));
    let unit = pool[0];
    if (selected.length && chars(body(unit, verb, selected.length, true)) > remaining + 12) unit = pool.filter(u => chars(body(u, verb, selected.length, true)) <= remaining + 12)[0] || unit;
    selected.push({ unit, verb }); usedUnits.add(`${unit.kind}:${unit.text}`); usedKinds.add(unit.kind); if (unit.source) usedSources.add(unit.source);
    unit.nouns.forEach(n => usedNouns.add(n)); unit.words.forEach(w => usedWords.add(w));
    previousWords = new Set(unit.words);
    if (unit.kind !== 'sentence') { usedVerbs.add(verb); usedWords.add(VERBS[verb][0]); previousWords.add(VERBS[verb][0]); }
    if (plan.preset === 'brief' || chars(composeSentence(subject, selected)) >= plan.targetChars - 8) break;
  }
  const text = composeSentence(subject, selected);
  return { text, materials: selected.map(({ unit }) => ({ kind: unit.kind, text: unit.text, source: unit.source })), clauseCount: selected.length };
}
export function sentenceFromClauses(clauses, plan) {
  const candidates = clauses.map(c => ({ kind: 'word', text: `${c.adjective}${c.object}`, nouns: [c.object], words: [c.object] }));
  return assembleSentence(clauses[0]?.subject, candidates, clauses.map((c, i) => ({ i, v: Math.max(0, VERBS.findIndex(v => v[0] === c.verb)) })), plan).text;
}

// Analysis runs in the history worker, away from the audio event loop.
export function cleanMaterial(text) {
  return String(text).replace(/```[\s\S]*?```|https?:\/\/\S+|<[@#][!&]?\d+>/g, ' ').replace(/[`*_~|]/g, '').trim();
}
export function materialUnits(text, analyzer) {
  const units = new Map();
  const add = (kind, value, tokens) => {
    const body = value.trim().replace(/[「」『』]/g, '');
    const words = [...new Set(tokens.filter(t => ['名詞', '動詞', '形容詞'].includes(t.pos)).map(t => t.basic_form === '*' ? t.surface_form : t.basic_form).filter(w => /\p{L}/u.test(w)))];
    const nounTokens = tokens.filter(t => t.pos === '名詞' && ['一般', '固有名詞', 'サ変接続'].includes(t.pos_detail_1)).map(t => t.basic_form === '*' ? t.surface_form : t.basic_form);
    const nouns = [...new Set(nounTokens)];
    if (nounTokens.length !== nouns.length) return;
    if (body && nouns.length) units.set(`${kind}:${body}`, { kind, text: body, words, nouns });
  };
  const sentences = new Set(cleanMaterial(text).slice(0, 2000).split(/[。！？!?\n]+/u).map(s => s.trim()).filter(Boolean));
  for (const sentence of sentences) {
    // Never present a truncated sentence as a complete source sentence.
    const whole = [...sentence].length <= 160;
    for (let offset = 0; offset < sentence.length; offset += 200) {
      const tokens = analyzer.tokenize(sentence.slice(offset, offset + 200));
      let phrase = [];
      const flush = () => {
        while (phrase.length && phrase.at(-1).pos !== '名詞') phrase.pop();
        const body = phrase.map(t => t.surface_form).join('');
        if ([...body].length >= 3 && [...body].length <= 40 && phrase.filter(t => ['名詞', '形容詞'].includes(t.pos)).length >= 2) add('phrase', body, phrase);
        phrase = [];
      };
      for (const token of tokens) {
        const nominal = ['名詞', '形容詞', '連体詞'].includes(token.pos);
        const link = phrase.length && (token.pos === '助詞' && token.surface_form === 'の' || token.pos === '助動詞' && token.surface_form === 'な');
        if (nominal || link) phrase.push(token); else flush();
      }
      flush();
      if (whole && offset === 0 && sentence.length >= 8 && tokens.some(t => t.pos === '助詞' && ['は', 'が'].includes(t.surface_form)) && tokens.some(t => t.pos === '動詞' || t.pos === '助動詞')) add('sentence', sentence, tokens);
    }
    if (units.size >= 64) break;
  }
  return [...units.values()].slice(0, 64);
}
export function trainMaterials(model, units, source = '') {
  for (const unit of units) {
    if (!['phrase', 'sentence'].includes(unit.kind)) continue;
    const key = `${unit.kind}:${unit.text}`, existing = model.materials.get(key);
    if (existing) existing.count++;
    else if (model.materialCounts[unit.kind] < 256) { model.materials.set(key, { ...unit, source, count: 1 }); model.materialCounts[unit.kind]++; }
  }
}

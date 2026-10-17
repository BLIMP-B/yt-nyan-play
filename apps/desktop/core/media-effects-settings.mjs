// Shared by the renderer, configuration validation and the Discord audio path.
export const EQ_FREQUENCIES = [100, 300, 1000, 3000, 8000];
export const EQ_PRESETS = {
  discord1: { name: 'Discord用1', preampDb: -2, gains: [-3, -2, 0, 1.5, 1] },
  discord2: { name: 'Discord用2', preampDb: -2, gains: [-5, -3, 1, 2, -1] },
  discord3: { name: 'Discord用3', preampDb: -2, gains: [-1, -1, 0, 0.5, 1.5] },
  flat: { name: 'フラット', preampDb: 0, gains: [0, 0, 0, 0, 0] },
  music: { name: '音楽', preampDb: -3, gains: [2, -1, 0, 1, 2] },
  clarity: { name: '声を聞きやすく', preampDb: -3, gains: [-4, -2, 1, 3, -1] },
  bassCut: { name: '低音を抑える', preampDb: 0, gains: [-6, -3, 0, 0, 0] },
  softTreble: { name: '高音をやわらかく', preampDb: 0, gains: [0, 0, 0, -2, -5] },
};
export const COMPRESSOR_PRESETS = {
  discord1: { name: 'Discord用1', thresholdDb: -20, ratio: 2.5, kneeDb: 6, attackMs: 10, releaseMs: 200, makeupDb: 2 },
  discord2: { name: 'Discord用2', thresholdDb: -22, ratio: 3, kneeDb: 8, attackMs: 8, releaseMs: 200, makeupDb: 3 },
  discord3: { name: 'Discord用3', thresholdDb: -14, ratio: 1.8, kneeDb: 6, attackMs: 25, releaseMs: 220, makeupDb: 1 },
  gentle: { name: '軽め', thresholdDb: -18, ratio: 2, kneeDb: 6, attackMs: 15, releaseMs: 180, makeupDb: 2 },
  level: { name: '音量差を抑える', thresholdDb: -24, ratio: 3, kneeDb: 8, attackMs: 10, releaseMs: 250, makeupDb: 4 },
  peaks: { name: 'ピークを抑える', thresholdDb: -9, ratio: 8, kneeDb: 3, attackMs: 1, releaseMs: 100, makeupDb: 0 },
};
const values = preset => Object.fromEntries(Object.entries(preset).filter(([key]) => key !== 'name'));
export function effectPreset(kind, id) {
  const preset = (kind === 'equalizer' ? EQ_PRESETS : COMPRESSOR_PRESETS)[id];
  return preset ? structuredClone(values(preset)) : null;
}
export const DEFAULT_EQUALIZER = { enabled: true, preset: 'discord1', ...effectPreset('equalizer', 'discord1') };
export const DEFAULT_COMPRESSOR = { enabled: true, preset: 'discord1', ...effectPreset('compressor', 'discord1') };

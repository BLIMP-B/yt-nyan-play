import { EQ_PRESETS, COMPRESSOR_PRESETS, effectPreset } from '../core/media-effects-settings.mjs';

export function setupMediaEffectsSettings(root = document) {
  const field = path => root.querySelector(`[data-config="media.${path}"]`);
  for (const [kind, presets] of [['equalizer', EQ_PRESETS], ['compressor', COMPRESSOR_PRESETS]]) {
    const select = field(`${kind}.preset`);
    for (const [value, name] of [...Object.entries(presets).map(([id, p]) => [id, p.name]), ['custom', 'カスタム']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = name; select.append(option);
    }
    select.addEventListener('change', () => {
      const preset = effectPreset(kind, select.value); if (!preset) return;
      for (const [key, value] of Object.entries(preset)) {
        if (Array.isArray(value)) value.forEach((gain, i) => { field(`${kind}.${key}.${i}`).value = gain; });
        else field(`${kind}.${key}`).value = value;
      }
      field(`${kind}.enabled`).checked = true;
    });
    root.querySelectorAll(`[data-config^="media.${kind}."][data-number]`).forEach(input => input.addEventListener('input', () => { select.value = 'custom'; }));
  }
}

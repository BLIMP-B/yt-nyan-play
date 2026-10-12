const svgNamespace = 'http://www.w3.org/2000/svg';

export function icon(name) {
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.classList.add('icon');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  const use = document.createElementNS(svgNamespace, 'use');
  use.setAttribute('href', `vendor/lucide/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

// Keep accessible names and tooltips even when the visible control is only an icon.
export function decorateButton(button, name, label = button.dataset.label || button.textContent.trim()) {
  button.dataset.icon = name;
  button.dataset.label = label;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.classList.add('action-button');
  button.classList.toggle('icon-button', button.hasAttribute('data-icon-only'));
  button.replaceChildren(icon(name));
  if (!button.hasAttribute('data-icon-only')) {
    const text = document.createElement('span');
    text.className = 'button-label';
    text.textContent = label;
    button.append(text);
  }
  return button;
}

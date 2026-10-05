(() => {
  if (!window.nyan) return;
  const canvas = document.getElementById('android-screen'), context = canvas.getContext('2d'); let drawing = false, down;
  const send = async data => { const result = await window.nyan.invoke('android:input', data); if (!result.ok) document.getElementById('android-progress').textContent = result.error; };
  window.nyan.onAndroidFrame(async bytes => { if (drawing) return; drawing = true; try { const picture = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); canvas.width = picture.width; canvas.height = picture.height; context.drawImage(picture, 0, 0); picture.close(); document.getElementById('android-empty').hidden = true; } finally { drawing = false; } });
  const point = event => { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / rect.width))), y: Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / rect.height))) }; };
  canvas.addEventListener('pointerdown', e => { e.preventDefault(); canvas.focus(); canvas.setPointerCapture(e.pointerId); down = { ...point(e), at: Date.now() }; });
  canvas.addEventListener('pointerup', e => { if (!down) return; const end = point(e), start = down; down = null; if (Math.abs(start.x - end.x) + Math.abs(start.y - end.y) > 15 || Date.now() - start.at > 500) void send({ type: 'swipe', x: start.x, y: start.y, endX: end.x, endY: end.y, duration: Date.now() - start.at }); else void send({ type: 'tap', ...end }); });
  canvas.addEventListener('pointercancel', () => { down = null; });
  canvas.addEventListener('keydown', e => { const keys = { Enter: 66, Backspace: 67, Tab: 61, Escape: 4, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22 }; if (keys[e.key]) { e.preventDefault(); void send({ type: 'key', code: keys[e.key] }); } else if (e.key.length === 1 && /^[\x20-\x7e]$/.test(e.key) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void send({ type: 'text', text: e.key }); } });
})();

(() => {
  if (!window.nyan) return;
  const canvas = document.getElementById('android-screen'), context = canvas.getContext('2d'); let drawing = false, down, blackFrames = 0;
  const frameState = document.getElementById('android-frame-state');
  const send = async data => { const result = await window.nyan.invoke('android:input', data); if (!result.ok) document.getElementById('android-progress').textContent = result.error; };
  window.nyan.onAndroidFrame(async bytes => {
    if (drawing) return; drawing = true;
    try {
      const picture = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); canvas.width = picture.width; canvas.height = picture.height; context.drawImage(picture, 0, 0); picture.close(); document.getElementById('android-empty').hidden = true;
      let black = true;
      for (const x of [0.25, 0.5, 0.75]) for (const y of [0.25, 0.5, 0.75]) { const pixel = context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data; if (pixel[0] > 8 || pixel[1] > 8 || pixel[2] > 8) black = false; }
      blackFrames = black ? blackFrames + 1 : 0; frameState.hidden = blackFrames < 3;
      if (blackFrames >= 3) frameState.textContent = '画面が黒く表示されています。保護画面の場合は「別ウィンドウで再起動」で操作してください。通常画面も黒い場合は、停止後に描画をソフトウェアへ変更してください。';
    } catch { frameState.hidden = false; frameState.textContent = 'Androidの画像を表示できません。「別ウィンドウで再起動」で画面を確認してください。'; }
    finally { drawing = false; }
  });
  window.nyan.subscribe(state => { if (state.android?.status !== 'running') { blackFrames = 0; frameState.hidden = true; document.getElementById('android-empty').hidden = false; } });
  const point = event => { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / rect.width))), y: Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / rect.height))) }; };
  canvas.addEventListener('pointerdown', e => { e.preventDefault(); canvas.focus(); canvas.setPointerCapture(e.pointerId); down = { ...point(e), at: Date.now() }; });
  canvas.addEventListener('pointerup', e => { if (!down) return; const end = point(e), start = down; down = null; if (Math.abs(start.x - end.x) + Math.abs(start.y - end.y) > 15 || Date.now() - start.at > 500) void send({ type: 'swipe', x: start.x, y: start.y, endX: end.x, endY: end.y, duration: Date.now() - start.at }); else void send({ type: 'tap', ...end }); });
  canvas.addEventListener('pointercancel', () => { down = null; });
  canvas.addEventListener('keydown', e => { const keys = { Enter: 66, Backspace: 67, Tab: 61, Escape: 4, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22 }; if (keys[e.key]) { e.preventDefault(); void send({ type: 'key', code: keys[e.key] }); } else if (e.key.length === 1 && /^[\x20-\x7e]$/.test(e.key) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void send({ type: 'text', text: e.key }); } });
})();

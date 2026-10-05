(() => {
  if (!window.nyan) return;
  const playing = new Map(); const captures = new Map();
  const stopCapture = async id => {
    const capture = captures.get(id); if (!capture) return; captures.delete(id); capture.stopping = true;
    capture.stream?.getTracks().forEach(track => track.stop()); capture.processor?.disconnect();
    await capture.context?.close();
  };
  const handleAudio = async message => {
    if (message.type === 'cancel') { const audio = playing.get(message.id); if (audio?.cancel) audio.cancel(); else { audio?.pause(); audio?.dispatchEvent(new Event('ended')); } return; }
    if (message.type === 'capture:stop') { await stopCapture(message.id); return; }
    try {
      if (message.type === 'play:timed') {
        const context = new AudioContext({ sampleRate: 48000 }); const source = context.createBufferSource(), gain = context.createGain();
        let finish;
        playing.set(message.id, { cancel: () => { try { source.stop(); } catch {} finish?.(); } });
        try {
          if (message.device && context.setSinkId) await context.setSinkId(message.device);
          source.buffer = await context.decodeAudioData(new Uint8Array(message.bytes).buffer); gain.gain.value = message.volume; source.connect(gain).connect(context.destination);
          await context.resume();
          await new Promise((resolve, reject) => {
            finish = resolve; source.onended = resolve;
            const remaining = (message.startAt - Date.now()) / 1000, offset = Math.max(0, -remaining);
            if (offset >= source.buffer.duration) return reject(new Error('時報の予約時刻を過ぎています'));
            source.start(context.currentTime + Math.max(0, remaining), offset);
          });
        } finally { playing.delete(message.id); try { source.stop(); } catch {} await context.close(); }
      }
      if (message.type === 'play') {
        const bytes = new Uint8Array(message.bytes);
        const url = URL.createObjectURL(new Blob([bytes], { type: bytes[0] === 82 && bytes[1] === 73 ? 'audio/wav' : '' }));
        const audio = new Audio(url); playing.set(message.id, audio); audio.volume = message.volume;
        try {
          if (message.device && audio.setSinkId) await audio.setSinkId(message.device);
          await new Promise((resolve, reject) => {
            audio.addEventListener('ended', resolve, { once: true }); audio.addEventListener('error', () => reject(new Error('PCの音声を再生できません')), { once: true });
            audio.play().catch(reject);
          });
        } finally { playing.delete(message.id); audio.pause(); URL.revokeObjectURL(url); }
      }
      if (message.type === 'capture:start') {
        await stopCapture(message.id);
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 } });
        const capture = { stream }; captures.set(message.id, capture);
        if (!stream.getAudioTracks().length) throw new Error('再生ウィンドウから音声を取得できません');
        const context = new AudioContext({ sampleRate: 48000 }); capture.context = context;
        await context.audioWorklet.addModule('pcm-worklet.js');
        const source = context.createMediaStreamSource(stream); const processor = new AudioWorkletNode(context, 'nyan-pcm'); capture.processor = processor;
        const failed = error => { if (!capture.stopping) { window.nyan.audioResult({ id: message.id, type: 'capture:error', error }); void stopCapture(message.id); } };
        processor.onprocessorerror = () => failed('音声転送の処理が停止しました');
        stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => failed('再生ウィンドウの音声接続が終了しました'), { once: true }));
        processor.port.onmessage = event => window.nyan.pcm(message.id, event.data);
        const mute = context.createGain(); mute.gain.value = 0; source.connect(processor).connect(mute).connect(context.destination); await context.resume();
      }
      window.nyan.audioResult({ id: message.id });
    } catch (error) { if (message.type === 'capture:start') await stopCapture(message.id); window.nyan.audioResult({ id: message.id, error: error.message }); }
  };
  window.nyan.onAudio(handleAudio);
  window.nyanCapture = handleAudio;
})();

(() => {
  if (!window.nyan) return;
  const playing = new Map(); const captures = new Map();
  let config = { outputDevice: '', voiceMonitorVolume: 0.8 }, monitor, monitorEpoch = 0;
  const warnedDevices = new Set();
  const setDevice = async (output, device = '') => {
    if (!output.setSinkId) return;
    try { await output.setSinkId(device); }
    catch (error) {
      if (!device) throw error;
      await output.setSinkId('');
      if (!warnedDevices.has(device)) { warnedDevices.add(device); window.nyan.audioResult({ type: 'device:warning' }); }
    }
  };
  const stopMonitor = () => {
    monitorEpoch++; const previous = monitor; monitor = null;
    previous?.processor?.disconnect(); previous?.gain?.disconnect(); void previous?.context.close();
  };
  const startMonitor = async id => {
    if (monitor?.id === id) return;
    stopMonitor(); const epoch = monitorEpoch;
    const context = new AudioContext({ sampleRate: 48000 }), current = monitor = { id, context };
    try {
      await setDevice(context, config.outputDevice); await context.audioWorklet.addModule('voice-monitor-worklet.js');
      if (epoch !== monitorEpoch) return;
      const processor = new AudioWorkletNode(context, 'nyan-voice-monitor', { outputChannelCount: [2] }), gain = context.createGain();
      current.processor = processor; current.gain = gain; gain.gain.value = config.voiceMonitorVolume; processor.connect(gain).connect(context.destination); await context.resume();
    } catch (error) { if (epoch === monitorEpoch) { stopMonitor(); window.nyan.audioResult({ type: 'monitor:error', error: error.message }); } }
  };
  window.nyan.onVoiceMonitor(message => {
    if (message.type === 'start') void startMonitor(message.id);
    else if (message.type === 'stop' && monitor?.id === message.id) stopMonitor();
    else if (message.type === 'pcm' && monitor?.id === message.id) monitor.processor?.port.postMessage(new Uint8Array(message.bytes));
  });
  window.nyanLocalAudio = { update: state => {
    const previous = config; config = state.config.desktop;
    if (state.voiceMonitor?.id) void startMonitor(state.voiceMonitor.id); else if (monitor) stopMonitor();
    if (monitor?.gain) monitor.gain.gain.setTargetAtTime(config.voiceMonitorVolume, monitor.context.currentTime, 0.02);
    if (config.outputDevice !== previous.outputDevice) {
      for (const output of [...playing.values()].map(p => p.context || p).concat([...captures.values()].filter(c => c.local).map(c => c.context), monitor?.context).filter(Boolean)) void setDevice(output, config.outputDevice).catch(error => window.nyan.audioResult({ type: 'device:warning', error: error.message }));
    }
  } };
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
        playing.set(message.id, { context, cancel: () => { try { source.stop(); } catch {} finish?.(); } });
        try {
          await setDevice(context, message.device);
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
          await setDevice(audio, message.device);
          await new Promise((resolve, reject) => {
            audio.addEventListener('ended', resolve, { once: true }); audio.addEventListener('error', () => reject(new Error('PCの音声を再生できません')), { once: true });
            audio.play().catch(reject);
          });
        } finally { playing.delete(message.id); audio.pause(); URL.revokeObjectURL(url); }
      }
      if (message.type === 'capture:start') {
        await stopCapture(message.id);
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 } });
        const capture = { stream, local: message.local === true }; captures.set(message.id, capture);
        if (!stream.getAudioTracks().length) throw new Error('再生ウィンドウから音声を取得できません');
        const context = new AudioContext({ sampleRate: 48000 }); capture.context = context;
        if (capture.local) await setDevice(context, message.device);
        await context.audioWorklet.addModule('pcm-worklet.js');
        const source = context.createMediaStreamSource(stream); const processor = new AudioWorkletNode(context, 'nyan-pcm'); capture.processor = processor;
        const failed = error => { if (!capture.stopping) { window.nyan.audioResult({ id: message.id, type: 'capture:error', error }); void stopCapture(message.id); } };
        processor.onprocessorerror = () => failed('音声転送の処理が停止しました');
        stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => failed('再生ウィンドウの音声接続が終了しました'), { once: true }));
        processor.port.onmessage = event => window.nyan.pcm(message.id, event.data);
        const gain = context.createGain(); gain.gain.value = capture.local ? 1 : 0; source.connect(processor).connect(gain).connect(context.destination); await context.resume();
      }
      window.nyan.audioResult({ id: message.id });
    } catch (error) { if (message.type === 'capture:start') await stopCapture(message.id); window.nyan.audioResult({ id: message.id, error: error.message }); }
  };
  window.nyan.onAudio(handleAudio);
  window.nyanCapture = handleAudio;
})();

export function mediaScript({ startSeconds = 0, mode = 'preview', volume = 0.7, paused = false, volumeRampMs = 0 }) {
  return `(() => {
    const options = ${JSON.stringify({ startSeconds, mode, volume, paused, volumeRampMs })};
    let playability;
    try { playability = document.querySelector('#movie_player')?.getPlayerResponse?.()?.playabilityStatus; } catch {}
    playability ||= window.ytInitialPlayerResponse?.playabilityStatus;
    const isAdvertisement = () => Boolean(document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting'));
    const advertisement = isAdvertisement();
    const blockedReason = playability && !['OK', 'LIVE_STREAM_OFFLINE'].includes(playability.status) ? String(playability.reason || playability.status).slice(0, 300) : '';
    const loginRequired = playability?.status === 'LOGIN_REQUIRED';
    const videos = [...document.querySelectorAll('video,audio')];
    const chosen = document.querySelector('#movie_player video') || videos.find(v => !v.paused && !v.ended) || videos.sort((a,b) => b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0];
    if (!chosen) return { found: false, blockedReason, loginRequired };
    const previous = window.__nyanMedia;
    if (previous !== chosen) { window.__nyanMedia = chosen; window.__nyanStarted = false; }
    chosen.muted = false; chosen.loop = false; chosen.playbackRate = 1;
    if (!options.volumeRampMs) { clearInterval(chosen.__nyanVolumeTimer); chosen.volume = options.volume; chosen.__nyanVolumeTarget = options.volume; }
    else if (chosen.__nyanVolumeTarget !== options.volume) {
      clearInterval(chosen.__nyanVolumeTimer); chosen.__nyanVolumeTarget = options.volume;
      const from = chosen.volume, began = Date.now();
      chosen.__nyanVolumeTimer = setInterval(() => {
        const progress = Math.min(1, (Date.now() - began) / options.volumeRampMs);
        chosen.volume = Math.max(0, Math.min(1, from + (options.volume - from) * progress));
        if (progress === 1 || chosen.ended) clearInterval(chosen.__nyanVolumeTimer);
      }, 20);
    }
    if (!advertisement && !window.__nyanStarted && chosen.readyState >= 1) {
      try { chosen.currentTime = Math.min(options.startSeconds, Number.isFinite(chosen.duration) ? Math.max(0,chosen.duration-0.05) : options.startSeconds); window.__nyanStarted = true; } catch {}
    }
    if (!advertisement && !chosen.__nyanBudget && options.mode === 'preview') {
      const budget = chosen.__nyanBudget = { timer: null, finished: false };
      const stopTimer = () => { clearTimeout(budget.timer); budget.timer = null; };
      const check = () => {
        stopTimer();
        if (!window.__nyanStarted || budget.finished || isAdvertisement()) return;
        const remaining = options.startSeconds + 45 - chosen.currentTime;
        if (remaining <= 0.02) { budget.finished = true; chosen.pause(); return; }
        if (!chosen.paused && chosen.readyState >= 3) budget.timer = setTimeout(check, Math.max(10, remaining * 1000));
      };
      for (const event of ['playing', 'timeupdate', 'seeked']) chosen.addEventListener(event, check);
      for (const event of ['pause', 'waiting', 'stalled', 'ended']) chosen.addEventListener(event, stopTimer);
      check();
    }
    if (advertisement && chosen.__nyanBudget) { clearTimeout(chosen.__nyanBudget.timer); chosen.__nyanBudget.timer = null; }
    if (options.paused || !advertisement && chosen.__nyanBudget?.finished) chosen.pause();
    else if (chosen.paused && !chosen.ended && !chosen.__nyanPlayPending) {
      chosen.__nyanPlayPending = true;
      chosen.play().then(() => { chosen.__nyanPlayError = null; }).catch(error => {
        if (error.name !== 'AbortError') chosen.__nyanPlayError = error.message || error.name;
      }).finally(() => { chosen.__nyanPlayPending = false; });
    }
    return { found: true, ready: chosen.readyState, paused: chosen.paused, ended: !advertisement && chosen.ended, advertisement,
      currentTime: chosen.currentTime, duration: Number.isFinite(chosen.duration) ? chosen.duration : null,
      previewFinished: !advertisement && chosen.__nyanBudget?.finished === true, audioOnly: chosen.tagName === 'AUDIO', pageTitle: document.title || '', blockedReason, loginRequired, error: chosen.__nyanPlayError || chosen.error?.code || null };
  })()`;
}

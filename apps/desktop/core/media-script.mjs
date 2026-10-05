export function mediaScript({ startSeconds = 0, mode = 'preview', volume = 0.7, paused = false }) {
  return `(() => {
    const options = ${JSON.stringify({ startSeconds, mode, volume, paused })};
    const playability = window.ytInitialPlayerResponse?.playabilityStatus || document.querySelector('#movie_player')?.getPlayerResponse?.()?.playabilityStatus;
    const blockedReason = playability && !['OK', 'LIVE_STREAM_OFFLINE'].includes(playability.status) ? String(playability.reason || playability.status).slice(0, 300) : '';
    const loginRequired = playability?.status === 'LOGIN_REQUIRED';
    const videos = [...document.querySelectorAll('video,audio')];
    const chosen = videos.find(v => !v.paused && !v.ended) || videos.sort((a,b) => b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0];
    if (!chosen) return { found: false, blockedReason, loginRequired };
    const previous = window.__nyanMedia;
    if (previous !== chosen) { window.__nyanMedia = chosen; window.__nyanStarted = false; }
    chosen.muted = false; chosen.volume = options.volume; chosen.loop = false; chosen.playbackRate = 1;
    if (!window.__nyanStarted && chosen.readyState >= 1) {
      try { chosen.currentTime = Math.min(options.startSeconds, Number.isFinite(chosen.duration) ? Math.max(0,chosen.duration-0.05) : options.startSeconds); window.__nyanStarted = true; } catch {}
    }
    if (!chosen.__nyanBudget && options.mode === 'preview') {
      const budget = chosen.__nyanBudget = { timer: null, finished: false };
      const stopTimer = () => { clearTimeout(budget.timer); budget.timer = null; };
      const check = () => {
        stopTimer();
        if (!window.__nyanStarted || budget.finished) return;
        const remaining = options.startSeconds + 45 - chosen.currentTime;
        if (remaining <= 0.02) { budget.finished = true; chosen.pause(); return; }
        if (!chosen.paused && chosen.readyState >= 3) budget.timer = setTimeout(check, Math.max(10, remaining * 1000));
      };
      for (const event of ['playing', 'timeupdate', 'seeked']) chosen.addEventListener(event, check);
      for (const event of ['pause', 'waiting', 'stalled', 'ended']) chosen.addEventListener(event, stopTimer);
      check();
    }
    if (options.paused || chosen.__nyanBudget?.finished) chosen.pause();
    else if (chosen.paused && !chosen.ended && !chosen.__nyanPlayPending) {
      chosen.__nyanPlayPending = true;
      chosen.play().then(() => { chosen.__nyanPlayError = null; }).catch(error => {
        if (error.name !== 'AbortError') chosen.__nyanPlayError = error.message || error.name;
      }).finally(() => { chosen.__nyanPlayPending = false; });
    }
    return { found: true, ready: chosen.readyState, paused: chosen.paused, ended: chosen.ended,
      currentTime: chosen.currentTime, duration: Number.isFinite(chosen.duration) ? chosen.duration : null,
      previewFinished: chosen.__nyanBudget?.finished === true, audioOnly: chosen.tagName === 'AUDIO', pageTitle: document.title || '', blockedReason, loginRequired, error: chosen.__nyanPlayError || chosen.error?.code || null };
  })()`;
}

export function mediaStreamBuffer(profile = 'poor') {
  const startupSeconds = ({ poor: 4, balanced: 2, fast: 1 })[profile] || 4;
  // Chromium keeps encoded Ogg bytes beyond its decoded TimeRanges. Reserve
  // three seconds at the fixed local 96-kbps rate, including quiet content.
  const decoderReserveSeconds = 3;
  return { startupSeconds, decoderReserveSeconds, burstSeconds: startupSeconds + decoderReserveSeconds + 2 };
}

// Best-effort startup only for finite third-party browser players. Our own
// non-seekable audio stream is buffered by OggPrefetch, not TimeRanges.
export function mediaBufferState(media, seconds = 0, { observed = false, now = Date.now() } = {}) {
  const time = Number(media.currentTime) || 0;
  let ahead = 0;
  for (let i = 0; i < (media.buffered?.length || 0); i++) {
    if (media.buffered.start(i) <= time + 0.05 && media.buffered.end(i) >= time) ahead = Math.max(ahead, media.buffered.end(i) - time);
  }
  if (!(seconds > 0) || !Number.isFinite(media.duration) || observed && !media.__nyanBuffer) return { buffering: false, bufferedSeconds: ahead };
  const remaining = Math.max(0, media.duration - time), target = Math.min(seconds, Math.max(0, remaining - .03));
  const state = media.__nyanBuffer ||= { primed: false, began: now };
  if (!state.primed && media.readyState >= 2 && (ahead + .03 >= target || now - state.began >= 8000 && ahead > 0)) state.primed = true;
  return { buffering: !state.primed && !media.ended, bufferedSeconds: ahead, bufferTargetSeconds: target };
}

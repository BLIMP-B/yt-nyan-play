export function mediaStreamBuffer(profile = 'poor') {
  const startupSeconds = ({ poor: 4, balanced: 2, fast: 1 })[profile] || 4;
  return { startupSeconds, burstSeconds: startupSeconds + 2 };
}

// Called in the playback page. Only the app's own HTTP audio stream is held:
// third-party adaptive players retain their own loading and buffering logic.
export function mediaBufferState(media, seconds = 0, expectedSeconds = null, finished = false) {
  const time = Number(media.currentTime) || 0;
  let ahead = 0;
  for (let i = 0; i < (media.buffered?.length || 0); i++) {
    if (media.buffered.start(i) <= time + 0.05 && media.buffered.end(i) >= time) ahead = Math.max(ahead, media.buffered.end(i) - time);
  }
  if (!(seconds > 0)) return { buffering: false, bufferedSeconds: ahead };
  const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : expectedSeconds;
  const remaining = Number.isFinite(duration) ? Math.max(0, duration - time) : Infinity;
  const target = Math.min(seconds, Math.max(0, remaining - 0.03));
  const state = media.__nyanBuffer ||= { primed: false, underruns: 0 };
  if (state.primed && !media.paused && !media.ended && media.readyState < 3 && ahead < 0.08 && remaining > 0.1) { state.primed = false; state.underruns++; }
  if (!state.primed && media.readyState >= 2 && (ahead + 0.03 >= target || finished && ahead > 0)) state.primed = true;
  return { buffering: !state.primed && !media.ended, bufferedSeconds: ahead, bufferTargetSeconds: target, bufferUnderruns: state.underruns };
}

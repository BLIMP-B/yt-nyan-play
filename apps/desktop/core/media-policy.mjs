export function mediaPolicy(payload = {}) {
  const mode = payload.mode || (payload.loop === true ? 'full' : 'preview');
  if (!['preview', 'full', 'direct'].includes(mode)) throw new Error('再生方式を確認してください');
  const seconds = payload.previewSeconds ?? 45;
  if (mode === 'preview' && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 45)) throw new Error('再生時間を確認してください');
  return { mode, limitSeconds: mode === 'preview' ? seconds : null };
}

export function streamContinuation(payload, state, stream) {
  const { limitSeconds } = mediaPolicy(payload), played = Math.max(0, Number(state.currentTime) || 0);
  const remaining = stream.expectedSeconds == null ? null : stream.expectedSeconds - played;
  if (remaining != null && remaining <= 0.5) return null;
  if (!stream.error && stream.finished && remaining == null) return null;
  if (limitSeconds != null && played >= limitSeconds - 0.05) return null;
  return { ...payload, startSeconds: (payload.startSeconds || 0) + played,
    ...(limitSeconds == null ? {} : { previewSeconds: limitSeconds - played }) };
}

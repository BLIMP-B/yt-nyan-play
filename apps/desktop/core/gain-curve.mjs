export function gainProgress(progress, curve = 'linear') {
  const p = Math.max(0, Math.min(1, progress));
  return curve === 'accelerate' ? p * p : p;
}

// Short linear segments follow the same quadratic envelope as the Discord
// mixer. They can be cancelled and held safely when another utterance starts.
export function scheduleGain(gain, target, at, seconds, curve = 'linear') {
  const from = gain.value, duration = Math.max(0, seconds);
  const shape = curve === 'accelerate' && target > from ? 'accelerate' : 'linear';
  gain.cancelAndHoldAtTime(at);
  gain.setValueAtTime(from, at);
  if (!duration) gain.setValueAtTime(target, at);
  else if (shape === 'accelerate') {
    for (let i = 1; i <= 64; i++) gain.linearRampToValueAtTime(from + (target - from) * gainProgress(i / 64, shape), at + duration * i / 64);
  } else gain.linearRampToValueAtTime(target, at + duration);
  return { from, to: target, startAt: at, duration, curve: shape };
}

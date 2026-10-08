// HTTP headers cannot contain the Japanese product name Electron adds by default.
// Use Chromium's normal browser identity for playback sites and net.fetch.
export function browserUserAgent(value) {
  return value.split(/\s+/).filter(token => /^[\x21-\x7e]+$/.test(token) && !/^(Electron|nyan-talk-damare|NyanTalk-Damare)\//i.test(token)).join(' ');
}

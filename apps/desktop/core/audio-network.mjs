// A steady packet budget avoids bitrate spikes on weak Wi-Fi/mobile links.
export const AUDIO_NETWORK_PROFILES = {
  poor: { bitrate: 48000, lossPercent: 20, receiveMs: 240, mediaMs: 240, rendererMs: 120 },
  balanced: { bitrate: 96000, lossPercent: 10, receiveMs: 120, mediaMs: 120, rendererMs: 80 },
  fast: { bitrate: 128000, lossPercent: 5, receiveMs: 80, mediaMs: 80, rendererMs: 80 },
};
export const audioNetwork = profile => AUDIO_NETWORK_PROFILES[profile] || AUDIO_NETWORK_PROFILES.poor;

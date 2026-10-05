export const MEDIA_ACCOUNTS = [
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', hosts: ['youtube.com', 'youtu.be'], authHosts: ['accounts.google.com', 'consent.google.com', 'consent.youtube.com'] },
  { id: 'niconico', name: 'ニコニコ動画', url: 'https://account.nicovideo.jp/login', hosts: ['nicovideo.jp', 'niconico.com', 'nico.ms'], authHosts: [] },
  { id: 'x', name: 'Twitter / X', url: 'https://x.com/i/flow/login', hosts: ['x.com', 'twitter.com'], authHosts: ['accounts.google.com', 'appleid.apple.com'] },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/accounts/login/', hosts: ['instagram.com'], authHosts: ['www.facebook.com', 'accountscenter.instagram.com', 'accountscenter.meta.com'] },
  { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com/login', hosts: ['tiktok.com'], authHosts: ['accounts.google.com', 'www.facebook.com', 'appleid.apple.com'] },
  { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com/login/', hosts: ['facebook.com', 'fb.watch'], authHosts: ['accountscenter.meta.com'] },
  { id: 'threads', name: 'Threads', url: 'https://www.threads.com/login', hosts: ['threads.com', 'threads.net'], authHosts: ['www.instagram.com', 'www.facebook.com', 'accountscenter.meta.com'] },
  { id: 'bluesky', name: 'Bluesky', url: 'https://bsky.app/', hosts: ['bsky.app'], authHosts: ['bsky.social'] },
];
export function mediaAccount(id) {
  const service = MEDIA_ACCOUNTS.find(s => s.id === id);
  if (!service) throw new Error('ログインするサービスを選択してください');
  return service;
}
export function mediaAuthHosts(source) {
  const host = new URL(source).hostname;
  return MEDIA_ACCOUNTS.find(s => s.hosts.some(h => host === h || host.endsWith('.' + h)))?.authHosts || [];
}

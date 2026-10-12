export function recentYoutubeMedia(jobs) {
  return jobs.filter(job => job.kind === 'media' && (job.mediaStartedAt || job.status === 'completed' && job.startedAt) && ['completed', 'running', 'cancelled', 'interrupted'].includes(job.status) && !job.payload.background)
    .sort((a, b) => Date.parse(b.mediaStartedAt || b.startedAt) - Date.parse(a.mediaStartedAt || a.startedAt))
    .map(job => { try { const url = new URL(job.payload.url); if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)(youtube\.com|youtu\.be)$/.test(url.hostname)) return null; return { url: url.toString(), title: job.payload.title || '直近のYouTube再生', fallback: 'history' }; } catch { return null; } }).find(Boolean) || null;
}
export async function hourlyBgmChoice(search, jobs, signal, log) {
  try { return await search(); }
  catch (error) {
    signal?.throwIfAborted();
    const recent = recentYoutubeMedia(jobs);
    if (!recent) throw error;
    log('warn', `YouTubeのBGM検索結果を取得できないため直近のYouTube再生履歴を使用します: ${recent.title}`);
    return recent;
  }
}

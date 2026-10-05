export function tweetSpeech(tweet, expanded = {}, options = {}) {
  const retweet = tweet.referenced_tweets?.find(r => r.type === 'retweeted');
  if (retweet && !options.readRetweets) return '';
  const original = retweet ? expanded.tweets?.find(t => t.id === retweet.id) : tweet;
  if (!original) return '';
  // Media-only tweets often contain just a t.co link. Do not speak the URL or a fabricated caption.
  const text = String(original.note_tweet?.text || original.text || '').replace(/https?:\/\/\S+/g, '').replace(/^RT\s+@\w+:\s*/, '').trim();
  if (!text) return '';
  const author = expanded.users?.find(u => u.id === original.author_id);
  return retweet ? `リポスト、${author?.name || author?.username || ''}。${text}` : text;
}
export function protectedReadable(account, owner) { return !account.protected || Boolean(owner && owner.id === account.id); }
export class XApi {
  constructor(fetcher = fetch) { this.fetcher = fetcher; }
  async request(path, token) {
    if (!token) throw new Error('XへのログインまたはAPI Bearer Tokenを設定してください');
    const response = await this.fetcher(`https://api.x.com/2${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) { const e = new Error(`X API: HTTP ${response.status}。API権限・利用枠・認証を確認してください`); e.status = response.status; throw e; }
    return response.json();
  }
  user(username, token) { return this.request(`/users/by/username/${encodeURIComponent(username)}?user.fields=protected,name,username`, token); }
  me(token) { return this.request('/users/me?user.fields=protected,name,username', token); }
  tweets(id, sinceId, token, readReplies = true, paginationToken = '') {
    const query = new URLSearchParams({ max_results: '100', 'tweet.fields': 'author_id,referenced_tweets,attachments,note_tweet,created_at', expansions: 'referenced_tweets.id,referenced_tweets.id.author_id', 'user.fields': 'name,username' });
    if (sinceId) query.set('since_id', sinceId); if (!readReplies) query.set('exclude', 'replies'); if (paginationToken) query.set('pagination_token', paginationToken);
    return this.request(`/users/${encodeURIComponent(id)}/tweets?${query}`, token);
  }
}

import { decorateButton } from './icons.js';
import { ServerSettings } from './server-settings.js';
import { HourlySettings } from './hourly-settings.js';
import { setupMediaEffectsSettings } from './media-effects-settings.js';

(() => {
  const api = window.nyan;
  if (!api) return;
  setupMediaEffectsSettings();
  const $ = id => document.getElementById(id);
  let state, speakers = [], initialized = false, toastTimer, bindingUpdates = Promise.resolve();
  const labels = { waiting: '待機中', running: '処理中', completed: '完了', failed: '失敗', interrupted: '中断', cancelled: '取消' };
  const fallbackStyles = [{ name: 'ずんだもん', styles: [{ id: 3, name: 'ノーマル' }, { id: 1, name: 'あまあま' }, { id: 7, name: 'ツンツン' }, { id: 5, name: 'セクシー' }, { id: 22, name: 'ささやき' }, { id: 38, name: 'ヒソヒソ' }, { id: 75, name: 'ヘロヘロ' }, { id: 76, name: 'なみだめ' }] }];
  function toast(text, error = false) { $('toast').textContent = text; $('toast').className = error ? 'toast error' : 'toast'; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 12000 : 5000); }
  async function invoke(action, data) { const result = await api.invoke(action, data); if (!result.ok) throw new Error(result.error); return result.value; }
  function task(callback) { return async event => { event?.preventDefault(); const button = event?.currentTarget; if (button?.tagName === 'BUTTON') button.disabled = true; try { await callback(event); } catch (e) { toast(e.message, true); } finally { if (button?.tagName === 'BUTTON') button.disabled = false; } }; }
  function node(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
  function button(text, name, callback) { const e = node('button', undefined, 'secondary'); e.type = 'button'; e.setAttribute('data-icon-only', ''); decorateButton(e, name, text); if (name === 'trash-2') e.setAttribute('data-danger', ''); e.addEventListener('click', task(callback)); return e; }
  function row(title, detail, controls = []) { const e = node('div', undefined, 'list-row'); const body = node('div', undefined, 'details'); body.append(node('strong', title), node('small', detail)); e.append(body); if (controls.length) { const actions = node('div', undefined, 'row-actions'); actions.append(...controls); e.append(actions); } return e; }
  function empty(target, text) { target.replaceChildren(node('p', text, 'subtle')); }
  function getPath(object, path) { return path.split('.').reduce((o, k) => o[k], object); }
  function setPath(object, path, value) { const keys = path.split('.'); const last = keys.pop(); keys.reduce((o, k) => o[k], object)[last] = value; }
  function draft() { const c = structuredClone(state.config); document.querySelectorAll('[data-config]').forEach(input => setPath(c, input.dataset.config, input.type === 'checkbox' ? input.checked : input.hasAttribute('data-seconds') ? Math.round(Number(input.value) * 1000) : input.hasAttribute('data-number') ? Number(input.value) : input.hasAttribute('data-list') ? input.value.split(/[,\n、]/).map(s => s.trim()).filter(Boolean) : input.value)); return c; }
  function fillConfig() { document.querySelectorAll('[data-config]').forEach(input => { const value = getPath(state.config, input.dataset.config); if (input.type === 'checkbox') input.checked = value; else input.value = input.hasAttribute('data-seconds') ? value / 1000 : Array.isArray(value) ? value.join(', ') : value; }); }
  async function save(c = draft()) { state = await invoke('config:save', c); renderStyles(); fillConfig(); render(state); document.querySelectorAll('.guild-picker[data-config]').forEach(input => { input.value = getPath(state.config, input.dataset.config); }); toast('設定を保存しました'); }
  function navigate(view) { document.querySelectorAll('[data-panel]').forEach(e => { e.hidden = e.dataset.panel !== view; }); document.querySelectorAll('nav [data-view]').forEach(e => { const active = e.dataset.view === view; e.classList.toggle('active', active); if (active) e.setAttribute('aria-current', 'page'); else e.removeAttribute('aria-current'); }); $('page-title').textContent = document.querySelector(`nav [data-view="${view}"]`).dataset.label; }
  function renderStyles() { const source = speakers.length ? speakers : fallbackStyles; document.querySelectorAll('#style-id,.style-picker').forEach(select => { const previous = select.value || String(state?.config.speech.styleId ?? 3); select.replaceChildren(); for (const speaker of source) { const group = node('optgroup'); group.label = speaker.name; for (const style of speaker.styles.filter(s => !s.type || s.type === 'talk')) { const option = node('option', `${speaker.name}・${style.name}`); option.value = style.id; group.append(option); } select.append(group); } if (![...select.options].some(o => o.value === previous)) { const option = node('option', `声種ID ${previous}`); option.value = previous; select.append(option); } select.value = previous; }); }
  function renderJobs() { if (!state) return; const target = $('job-list'), filter = $('queue-filter').value; target.replaceChildren(); const jobs = state.jobs.filter(j => filter === 'all' || (filter === 'failed' ? ['failed', 'interrupted'].includes(j.status) : j.status === filter)); for (const job of jobs.slice(0, 300)) { const controls = []; if (['waiting', 'running'].includes(job.status)) controls.push(button('リクエストを取り消す', 'x', async () => render(await invoke('job:action', { id: job.id, action: 'cancel' })))); else controls.push(button('リクエストを再実行', 'refresh-cw', async () => render(await invoke('job:action', { id: job.id, action: 'retry' })))); target.append(row(`${job.kind === 'media' ? '▶' : '◉'} ${job.payload.title || job.payload.text || job.payload.url}`, `${labels[job.status]} · ${new Date(job.createdAt).toLocaleString('ja-JP')}${job.error ? ` · ${job.error}` : ''}`, controls)); } if (!jobs.length) empty(target, '該当するリクエストはありません。'); }
  function renderCollections() {
    const c = state.config;
    const collections = [
      ['dictionary-list', c.dictionary, d => [d.source + ' → ' + d.replacement, `${d.scope}${d.scopeId ? ': ' + d.scopeId : ''}${d.regex ? ' · 正規表現' : ''}`], (config, d) => { config.dictionary = config.dictionary.filter(x => x.id !== d.id); }],
      ['profile-list', c.speech.profiles, p => [p.name || p.userId, `利用者 ${p.userId} · 声種 ${p.styleId} · 話速 ${p.speed}`], (config, p) => { config.speech.profiles = config.speech.profiles.filter(x => x.userId !== p.userId); }],
      ['clip-list', c.speech.soundClips, p => [p.trigger, p.path], (config, p) => { config.speech.soundClips = config.speech.soundClips.filter(x => x.trigger !== p.trigger); }],
      ['forward-list', c.speech.forwarding, f => [`${f.fromGuildId} → ${f.toGuildId}`, { 'one-way': '片方向', 'two-way': '双方向', none: '転送なし' }[f.mode]], (config, f) => { config.speech.forwarding = config.speech.forwarding.filter(x => x.fromGuildId !== f.fromGuildId || x.toGuildId !== f.toGuildId); }],
    ];
    for (const [id, values, describe, remove] of collections) {
      const target = $(id); target.replaceChildren();
      for (const value of values) {
        const [title, detail] = describe(value);
        const controls = [button(`${title}を削除`, 'trash-2', async () => { const config = draft(); remove(config, value); await save(config); })];
        const item = row(title, detail, controls);
        target.append(item);
      }
      if (!values.length) empty(target, 'まだ登録されていません。');
    }
  }
  function updateBinding(guild, change) {
    const pending = bindingUpdates.catch(() => {}).then(async () => {
      const config = draft();
      let binding = config.bot.bindings.find(b => b.guildId === guild.id);
      const previousVoice = binding?.voiceChannelId;
      if (!binding) { binding = { guildId: guild.id, label: guild.name, voiceChannelId: '', textChannelIds: [], disabledTextChannelIds: [], readEnabled: true, announceJoinLeave: null }; config.bot.bindings.push(binding); }
      change(binding);
      if (previousVoice && previousVoice !== binding.voiceChannelId && !binding.textChannelIds.includes(previousVoice)) binding.textChannelIds.push(previousVoice);
      await save(config);
      if (previousVoice && previousVoice !== binding.voiceChannelId && state.bot.status === 'online' && state.voices.some(v => v.guildId === guild.id)) render(await invoke('voice:join', guild.id));
    });
    bindingUpdates = pending;
    return pending;
  }
  const serverSettings = new ServerSettings($('binding-list'), {
    update: updateBinding,
    join: async guildId => render(await invoke('voice:join', guildId)),
    leave: async guildId => render(await invoke('voice:leave', guildId)),
    remove: guildId => {
      const pending = bindingUpdates.catch(() => {}).then(async () => {
        if (state.voices.some(v => v.guildId === guildId)) render(await invoke('voice:leave', guildId));
        const config = draft(); config.bot.bindings = config.bot.bindings.filter(b => b.guildId !== guildId); await save(config);
      });
      bindingUpdates = pending; return pending;
    },
    error: error => toast(error.message, true),
  });
  const hourlySettings = new HourlySettings($('hourly-servers'), {
    update: (id, change) => { const pending = bindingUpdates.catch(() => {}).then(async () => { const c = draft(); let s = c.hourly.servers.find(s => s.guildId === id); if (!s) { s = { guildId: id, enabled: true, bgm: true, channelIds: [] }; c.hourly.servers.push(s); } change(s); await save(c); }); bindingUpdates = pending; return pending; },
    remove: async id => { const c = draft(); c.hourly.servers = c.hourly.servers.filter(s => s.guildId !== id); await save(c); },
    generate: async guildId => { await save(); const result = await invoke('hourly:generate', { guildId }); toast(`${result.text}（${(result.elapsedMs / 1000).toFixed(2)}秒）`); },
    test: async guildId => { await save(); await invoke('hourly:test', { guildId }); }, error: error => toast(error.message, true),
  });
  function render(next) {
    state = next;
    window.nyanLocalAudio?.update(state);
    const monitorPicker = $('voice-monitor-guild'), monitorValue = monitorPicker.dataset.populated ? monitorPicker.value : state.config.desktop.voiceMonitorGuildId;
    monitorPicker.dataset.populated = 'true'; monitorPicker.replaceChildren(node('option', '通話音声を聞かない')); monitorPicker.firstChild.value = '';
    for (const binding of state.config.bot.bindings) { const guild = state.bot.servers.find(g => g.id === binding.guildId), channel = guild?.channels.find(c => c.id === binding.voiceChannelId); const option = node('option', `${guild?.name || binding.label || binding.guildId} / ${channel?.name || binding.voiceChannelId}`); option.value = binding.guildId; monitorPicker.append(option); }
    if (monitorValue && ![...monitorPicker.options].some(o => o.value === monitorValue)) { const option = node('option', `未設定のサーバー ${monitorValue}`); option.value = monitorValue; monitorPicker.append(option); }
    monitorPicker.value = monitorValue;
    $('voice-monitor-status').textContent = !state.config.desktop.voiceMonitorGuildId ? '通話音声の受信は停止中です。' : state.voiceMonitor?.status === 'listening' ? '選択したVCの通話音声をPCへ出力しています。' : state.voiceMonitor?.error || '選択したVCへのBot接続を待っています。';
    document.body.dataset.theme = state.config.desktop.theme; document.body.classList.toggle('vs-dark', state.config.desktop.theme === 'dark'); document.body.classList.toggle('vs', state.config.desktop.theme === 'light'); decorateButton($('theme-toggle'), state.config.desktop.theme === 'light' ? 'moon' : 'sun', state.config.desktop.theme === 'light' ? 'ダークモードに切り替え' : 'ライトモードに切り替え');
    if (!initialized) { renderStyles(); fillConfig(); initialized = true; }
    const status = { offline: '停止中', connecting: '接続中', online: '接続済み', reconnecting: '再接続中' }[state.bot.status] || state.bot.status;
    $('status-badge').textContent = status; $('status-badge').classList.toggle('mint', state.bot.status === 'online'); $('sidebar-status').textContent = `Bot ${status}`; $('sidebar-dot').classList.toggle('online', state.bot.status === 'online'); $('bot-start').disabled = state.bot.status !== 'offline'; $('bot-stop').disabled = state.bot.status === 'offline'; $('version').textContent = `v${state.version}`;
    $('token-state').textContent = state.tokenSaved ? '保存済み' : '未設定'; $('token-state').classList.toggle('mint', state.tokenSaved); $('token-form').querySelector('button').disabled = !state.vaultAvailable;
    if (!state.vaultAvailable) $('bot-token').placeholder = 'この環境ではOSの暗号化機能を利用できません';
    decorateButton($('pause-toggle'), state.paused.media || state.paused.speech ? 'play' : 'pause', state.paused.media || state.paused.speech ? '再開' : '一時停止');
    const current = state.jobs.filter(j => j.status === 'running'); const now = $('now-playing'); now.replaceChildren(); if (current.length) { for (const j of current) { now.append(node('strong', j.payload.title || j.payload.text || j.payload.url)); now.append(node('small', j.payload.master ? 'マスタキュー: 全サーバー共通' : `サーバー: ${j.payload.guildId || 'ローカル'}`)); } } else now.append(node('p', '再生中の項目はありません'));
    document.querySelectorAll('.guild-picker').forEach(select => {
      let value = select.dataset.populated ? select.value : select.dataset.config ? getPath(state.config, select.dataset.config) : select.value;
      const ready = state.voices.filter(v => v.status === 'ready');
      if (!value && !select.dataset.config) value = ready.length === 1 ? ready[0].guildId : !ready.length && state.config.bot.bindings.length === 1 ? state.config.bot.bindings[0].guildId : '';
      select.dataset.populated = 'true'; select.replaceChildren(node('option', '送信先サーバーを選択')); select.firstChild.value = '';
      for (const b of state.config.bot.bindings) { const option = node('option', b.label || b.guildId); option.value = b.guildId; select.append(option); } select.value = value;
    });
    const services = $('media-account-service');
    if (!services.options.length) for (const service of state.mediaAccounts || []) { const option = node('option', service.name); option.value = service.id; services.append(option); }
    renderAccountLink();
    serverSettings.render(state);
    hourlySettings.render(state);
    if (state.hourly) {
      const h = state.hourly; $('hourly-phase').textContent = h.phase; $('hourly-next').textContent = h.error || (h.nextAt ? `次の時報: ${new Date(h.nextAt).toLocaleString('ja-JP')}` : 'PCの時計に合わせて正時を待ちます。');
      $('hourly-model-state').textContent = h.model.progress || (h.model.installed ? '実行環境は導入済み' : '未導入。PC内の既存SLMも利用できます。'); $('hourly-model-setup').disabled = h.model.busy; $('hourly-model-cancel').disabled = !h.model.busy;
      $('hourly-history-state').textContent = `${h.history.messages}件 · ${h.history.progress || '未取得'}${h.history.errors.length ? ' · ' + h.history.errors.join(' / ') : ''}`; $('hourly-sync').disabled = h.history.syncing || state.bot.status !== 'online'; $('hourly-sync-cancel').disabled = !h.history.syncing; $('hourly-history-clear').disabled = h.history.syncing;
      $('hourly-test').disabled = h.busy; $('hourly-cancel').disabled = !h.busy;
      if (h.active) { if (!current.length) now.replaceChildren(); now.append(node('strong', h.active.text), node('small', `${h.phase} · 4点目: ${new Date(h.active.fourthAt).toLocaleTimeString('ja-JP')}`)); for (const s of h.active.servers) now.append(node('strong', s.text), node('small', `サーバー ${s.guildId} · ${s.phase}`)); }
    }
    renderJobs(); renderCollections(); const logs = $('log-list'); logs.replaceChildren(); for (const entry of state.logs) logs.append(row(entry.text, `${new Date(entry.time).toLocaleTimeString('ja-JP')} · ${entry.level}`)); if (!state.logs.length) empty(logs, 'イベントはまだありません。');
    if (state.bouyomi) {
      const legacy = state.bouyomi; $('bouyomi-state').textContent = legacy.imported ? `${legacy.version} / ${legacy.running ? '起動中' : '停止中'} / 配信者向け機能 ${legacy.broadcasterMode ? 'ON' : 'OFF'}${legacy.error ? ' / ' + legacy.error : ''}` : '未取り込み';
      $('bouyomi-start').disabled = !legacy.imported || legacy.running; $('bouyomi-stop').disabled = !legacy.running; $('bouyomi-folder').disabled = !legacy.imported;
      const list = $('bouyomi-dictionaries'); list.replaceChildren(); for (const d of legacy.dictionaries || []) list.append(row(d.name, `${d.count}件`));
    }
    if (state.android) {
      const android = state.android; $('android-status').textContent = { stopped: '停止中', booting: '起動中', running: '起動済み', error: 'エラー' }[android.status]; $('android-progress').textContent = android.progress || '停止中';
      $('android-start').disabled = android.busy || !android.ready || ['booting', 'running'].includes(android.status); $('android-stop').disabled = !['booting', 'running'].includes(android.status); $('android-setup').disabled = android.busy; $('android-cancel').disabled = !android.busy;
      $('android-window').disabled = android.busy || !android.ready || android.status === 'booting';
      const picker = $('android-image'); if (android.catalog.length && picker.dataset.catalog !== JSON.stringify(android.catalog)) { const selected = picker.value; picker.replaceChildren(); for (const image of android.catalog) { const option = node('option', `Android API ${image.api} / Google Play / rev ${image.revision}`); option.value = image.id; picker.append(option); } picker.value = selected; if (!picker.value) picker.value = state.config.android.image; picker.dataset.catalog = JSON.stringify(android.catalog); }
      $('android-licenses').value = android.licenses.map(l => `${l.id}\n\n${l.text}`).join('\n\n'); if (android.licenseImage !== state.config.android.image) $('android-accept').checked = false;
      const notifications = android.notifications; $('android-notification-state').textContent = notifications?.error ? `通知の取得: ${notifications.error}` : notifications?.enabled ? `${android.status === 'running' ? '通知を待っています' : 'Android起動後に通知を取得します'} / 読み上げ受付 ${notifications.count}件` : '通知読み上げはオフです';
    }
    if (state.twitter) { $('twitter-status').textContent = state.twitter.running ? '取得中' : '停止中'; $('twitter-login-state').textContent = state.twitter.login ? `@${state.twitter.login.username} としてログイン中` : state.twitter.loginProcessing ? 'Xの認証を処理中' : state.twitter.loginWaiting ? 'Xへのログインを待っています' : '未ログイン'; $('twitter-login-cancel').disabled = !state.twitter.loginWaiting; $('twitter-callback-url').textContent = `Callback URL: ${state.twitter.callbackUrl}`; $('twitter-start').disabled = state.twitter.running; $('twitter-stop').disabled = !state.twitter.running; const list = $('twitter-accounts'); list.replaceChildren(); for (const account of state.twitter.accounts) list.append(row(`@${account.username}`, account.status)); if (state.twitter.error) list.append(row('取得エラー', state.twitter.error)); }
  }
  document.querySelectorAll('[data-view],[data-go]').forEach(e => e.addEventListener('click', () => navigate(e.dataset.view || e.dataset.go)));
  document.querySelectorAll('.save-config').forEach(e => e.addEventListener('click', task(() => save())));
  document.querySelector('[data-config="desktop.networkProfile"]').addEventListener('change', event => {
    document.querySelector('[data-config="desktop.audioBitrateKbps"]').value = { poor: 48, balanced: 96, fast: 128 }[event.target.value];
  });
  const actions = { 'bot-start': 'bot:start', 'bot-stop': 'bot:stop', 'show-media': 'media:show', 'open-docs': 'open:docs', 'open-voicevox': 'open:voicevox', 'stop-engine': 'engine:stop', 'export-config': 'config:export' };
  function renderAccountLink() {
    const youtube = $('media-account-service').value === 'youtube', link = state.accountLink || {};
    $('youtube-account-help').hidden = !youtube; $('embedded-account-help').hidden = youtube;
    $('media-account-code').value = link.code || ''; $('media-account-copy').disabled = !link.code; $('media-account-cancel').disabled = !link.code;
    $('media-account-status').textContent = link.status === 'received' ? 'YouTubeのログイン情報を受け取りました。再生をお試しください。' : link.status === 'expired' ? '接続コードの期限が切れました。ログイン画面を開いて再発行してください。' : link.code ? `にゃんぷれいの設定へ貼り付けてください。有効期限: ${new Date(link.expiresAt).toLocaleTimeString('ja-JP')}` : 'にゃんぷれい v0.2.2以降が必要です。';
  }
  $('media-account-service').addEventListener('change', renderAccountLink);
  $('media-account-open').addEventListener('click', task(async () => { await invoke('media:login', $('media-account-service').value); render(await invoke('state')); }));
  $('media-account-copy').addEventListener('click', task(async () => { await invoke('media:account-copy'); toast('接続コードをコピーしました。にゃんぷれいの設定へ貼り付けてください'); }));
  $('media-account-cancel').addEventListener('click', task(async () => { await invoke('media:account-cancel'); render(await invoke('state')); }));
  for (const [id, action] of Object.entries(actions)) $(id).addEventListener('click', task(async () => { const value = await invoke(action); if (value?.config) render(value); }));
  $('pause-toggle').addEventListener('click', task(async () => render(await invoke('control', state.paused.media || state.paused.speech ? 'resume' : 'pause'))));
  $('skip-media').addEventListener('click', task(async () => render(await invoke('control', 'skip')))); $('stop-all').addEventListener('click', task(async () => render(await invoke('control', 'stop'))));
  $('token-form').addEventListener('submit', task(async () => { await invoke('token:save', $('bot-token').value); $('bot-token').value = ''; render(await invoke('state')); toast('Botトークンを暗号化して保存しました'); }));
  $('clear-token').addEventListener('click', task(async () => { await invoke('token:clear'); render(await invoke('state')); toast('Botトークンを削除しました'); }));
  $('binding-form').addEventListener('submit', task(async () => {
    const guildId = $('binding-guild').value.trim(), label = $('binding-label').value.trim(), voiceChannelId = $('binding-voice').value.trim();
    const textChannelIds = $('binding-text').value.split(/[,\n、]/).map(s => s.trim()).filter(Boolean);
    await updateBinding({ id: guildId, name: label }, b => { b.label = label; b.voiceChannelId = voiceChannelId; b.textChannelIds = textChannelIds; });
    $('binding-form').reset();
  }));
  $('dictionary-form').addEventListener('submit', task(async () => { const c = draft(); c.dictionary.push({ source: $('dict-source').value, replacement: $('dict-replacement').value, scope: $('dict-scope').value, scopeId: $('dict-scope-id').value.trim(), regex: $('dict-regex').checked, caseSensitive: false }); await save(c); $('dictionary-form').reset(); }));
  $('profile-form').addEventListener('submit', task(async () => { const c = draft(), p = { userId: $('profile-id').value.trim(), name: $('profile-name').value, styleId: Number($('profile-style').value), speed: Number($('profile-speed').value) }; c.speech.profiles = c.speech.profiles.filter(x => x.userId !== p.userId); c.speech.profiles.push(p); await save(c); $('profile-form').reset(); }));
  $('choose-clip').addEventListener('click', task(async () => { const path = await invoke('clip:choose'); if (path) $('clip-path').value = path; }));
  $('clip-form').addEventListener('submit', task(async () => { const c = draft(), clip = { trigger: $('clip-trigger').value, path: $('clip-path').value }; c.speech.soundClips = c.speech.soundClips.filter(x => x.trigger !== clip.trigger); c.speech.soundClips.push(clip); await save(c); $('clip-form').reset(); }));
  $('choose-engine').addEventListener('click', task(async () => { const path = await invoke('engine:choose'); if (path) $('engine-executable').value = path; }));
  $('start-engine').addEventListener('click', task(async () => { await save(); render(await invoke('engine:start')); }));
  $('refresh-voices').addEventListener('click', task(async () => { await save(); speakers = await invoke('voices:list'); renderStyles(); toast('声種を読み込みました'); }));
  $('check-styles').addEventListener('click', task(async () => { await save(); const result = await invoke('voices:check', { synthesize: true }); $('voice-check-result').textContent = `${result.styles.length}声種の音声合成を確認しました`; toast('ずんだもん全声種の確認が完了しました'); }));
  $('speech-form').addEventListener('submit', task(async () => { await save(); await invoke('speech:test', { text: $('speech-test').value, guildId: $('speech-guild').value, styleId: Number($('style-id').value) }); toast('読み上げを追加しました'); }));
  $('media-form').addEventListener('submit', task(async () => { await invoke('media:add', { url: $('media-url').value, startSeconds: Number($('media-time').value), mode: $('media-mode').value, master: $('media-master').checked, guildId: $('media-guild').value }); $('media-url').value = ''; toast('再生キューに追加しました'); }));
  $('import-config').addEventListener('click', task(async () => { const value = await invoke('config:import'); if (value) { render(value); renderStyles(); fillConfig(); toast('設定を読み込みました'); } }));
  $('queue-filter').addEventListener('change', renderJobs);
  $('theme-toggle').addEventListener('click', task(async () => { const c = draft(); c.desktop.theme = state.config.desktop.theme === 'light' ? 'dark' : 'light'; await save(c); }));
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyL') { event.preventDefault(); if (!$('theme-toggle').disabled) $('theme-toggle').click(); } });
  for (const [id, action] of Object.entries({ 'bouyomi-import': 'bouyomi:import', 'bouyomi-start': 'bouyomi:start', 'bouyomi-stop': 'bouyomi:stop', 'bouyomi-folder': 'bouyomi:folder' })) $(id).addEventListener('click', task(async () => { const value = await invoke(action); if (value?.config) { render(value); fillConfig(); } else render(await invoke('state')); }));
  $('android-refresh').addEventListener('click', task(async () => { await save(); await invoke('android:catalog'); render(await invoke('state')); toast('Androidバージョン一覧を更新しました'); }));
  $('android-image').addEventListener('change', () => { $('android-accept').checked = false; });
  $('android-setup').addEventListener('click', task(async () => { if (!$('android-accept').checked || !state.android.licenses.length) throw new Error('先に利用規約を取得・確認して同意してください'); await save(); await invoke('android:setup', { accepted: true }); render(await invoke('state')); toast('Androidのセットアップ・更新が完了しました'); }));
  for (const [id, action] of Object.entries({ 'android-start': 'android:start', 'android-window': 'android:window', 'android-stop': 'android:stop', 'android-cancel': 'android:cancel', 'android-play': 'android:play' })) $(id).addEventListener('click', task(async () => { if (action === 'android:start') await save(); await invoke(action); render(await invoke('state')); }));
  for (const [id, code] of Object.entries({ 'android-back': 4, 'android-home': 3, 'android-recent': 187 })) $(id).addEventListener('click', task(() => invoke('android:input', { type: 'key', code })));
  for (const [id, action, field] of [['android-choose-sdk', 'android:choose-sdk', 'android-sdk'], ['android-choose-java', 'android:choose-java', 'android-java']]) $(id).addEventListener('click', task(async () => { const path = await invoke(action); if (path) $(field).value = path; }));
  $('android-text-form').addEventListener('submit', task(async () => { const text = $('android-text').value; $('android-text').value = ''; await invoke('android:input', { type: 'text', text }); }));
  $('android-package-form').addEventListener('submit', task(() => invoke('android:play', { packageId: $('android-package').value.trim() })));
  $('forward-form').addEventListener('submit', task(async () => { const c = draft(), f = { fromGuildId: $('forward-from').value, toGuildId: $('forward-to').value, mode: $('forward-mode').value }; c.speech.forwarding = c.speech.forwarding.filter(x => x.fromGuildId !== f.fromGuildId || x.toGuildId !== f.toGuildId); c.speech.forwarding.push(f); await save(c); }));
  for (const [id, action] of Object.entries({ 'twitter-start': 'twitter:start', 'twitter-stop': 'twitter:stop', 'twitter-login': 'twitter:login', 'twitter-logout': 'twitter:logout', 'twitter-login-cancel': 'twitter:login-cancel', 'twitter-token-clear': 'twitter:app-token-clear' })) $(id).addEventListener('click', task(async () => { if (['twitter:start', 'twitter:login'].includes(action)) await save(); await invoke(action); render(await invoke('state')); }));
  $('twitter-token-form').addEventListener('submit', task(async () => { await invoke('twitter:app-token', $('twitter-app-token').value); $('twitter-app-token').value = ''; toast('X認証情報を暗号化して保存しました'); }));
  for (const [id, action] of Object.entries({ 'hourly-test': 'hourly:test', 'hourly-cancel': 'hourly:cancel', 'hourly-model-setup': 'hourly:model-setup', 'hourly-model-cancel': 'hourly:model-cancel', 'hourly-sync': 'hourly:sync', 'hourly-sync-cancel': 'hourly:sync-cancel', 'hourly-history-clear': 'hourly:history-clear' })) $(id).addEventListener('click', task(async () => { if (['hourly:test', 'hourly:model-setup', 'hourly:sync'].includes(action)) await save(); await invoke(action); render(await invoke('state')); }));
  $('hourly-server-form').addEventListener('submit', task(async () => { const id = $('hourly-server-id').value; await hourlySettings.actions.update(id, s => { s.enabled = true; s.channelIds = $('hourly-channel-ids').value.split(/[,\n、]/).map(s => s.trim()).filter(Boolean); }); $('hourly-server-form').reset(); }));
  document.querySelectorAll('button[data-icon]').forEach(e => decorateButton(e, e.dataset.icon));
  document.querySelector('nav .active').setAttribute('aria-current', 'page');
  api.subscribe(render);
  async function refreshDevices() {
    const picker = $('output-device'), value = picker.dataset.populated ? picker.value : state.config.desktop.outputDevice;
    picker.dataset.populated = 'true';
    picker.replaceChildren(node('option', '既定のデバイス')); picker.firstChild.value = '';
    const devices = await navigator.mediaDevices?.enumerateDevices() || [];
    for (const device of devices.filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')) { const option = node('option', device.label || device.deviceId); option.value = device.deviceId; picker.append(option); }
    if (value && ![...picker.options].some(o => o.value === value)) { const option = node('option', '保存済みのデバイス（現在未接続）'); option.value = value; picker.append(option); }
    picker.value = value;
  }
  $('refresh-devices').addEventListener('click', task(refreshDevices));
  navigator.mediaDevices?.addEventListener('devicechange', () => void refreshDevices().catch(e => toast(e.message, true)));
  task(async () => { render(await invoke('state')); await refreshDevices(); fillConfig(); })();
})();

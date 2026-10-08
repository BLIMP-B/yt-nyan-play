import { decorateButton, icon } from './icons.js';
const node = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
export class HourlySettings {
  constructor(container, actions) { this.container = container; this.actions = actions; this.key = ''; }
  listen(input, callback) { input.addEventListener('change', () => Promise.resolve(callback(input.checked)).catch(this.actions.error)); return input; }
  check(label, checked, disabled, callback) { const e = node('label', undefined, 'checkbox'), input = node('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = disabled; input.setAttribute('aria-label', label); e.append(this.listen(input, callback), node('span', label)); return e; }
  render(state) {
    const key = JSON.stringify([state.bot.servers, state.config.hourly.servers, state.hourly?.measurements]); if (key === this.key) return; this.key = key;
    const open = new Map([...this.container.querySelectorAll('details')].map(e => [e.dataset.guild, e.open])); this.container.replaceChildren();
    const guilds = new Map(state.bot.servers.map(g => [g.id, g]));
    for (const s of state.config.hourly.servers) if (!guilds.has(s.guildId)) guilds.set(s.guildId, { id: s.guildId, name: s.guildId, channels: [] });
    for (const guild of guilds.values()) {
      const server = state.config.hourly.servers.find(s => s.guildId === guild.id), card = node('details', undefined, 'server-setting'); card.dataset.guild = guild.id; card.open = open.get(guild.id) ?? Boolean(server?.enabled);
      const summary = node('summary'); summary.append(node('strong', guild.name), node('span', server?.enabled ? '生成文あり' : '共通時報のみ', 'subtle')); card.append(summary);
      const body = node('div', undefined, 'server-setting-body');
      body.append(this.check(`${guild.name}の生成文を読み上げる`, Boolean(server?.enabled), false, checked => this.actions.update(guild.id, s => { s.enabled = checked; })), this.check('生成文の名詞2語＋フリーBGMでYouTubeを検索', server?.bgm !== false, !server?.enabled, checked => this.actions.update(guild.id, s => { s.bgm = checked; })));
      const list = node('div', undefined, 'channel-grid');
      for (const channel of guild.channels.filter(c => c.text !== false)) {
        const label = this.check(channel.name, Boolean(server?.channelIds.includes(channel.id)), channel.canHistory === false || channel.canRead === false, checked => this.actions.update(guild.id, s => { s.channelIds = s.channelIds.filter(id => id !== channel.id); if (checked) s.channelIds.push(channel.id); }));
        label.classList.add('channel-choice'); label.insertBefore(icon(channel.voice ? 'mic' : 'hash'), label.lastChild); label.title = `${channel.name} · ${channel.id}${channel.canHistory === false ? '（履歴の閲覧権限なし）' : ''}`; list.append(label);
      }
      body.append(node('strong', '文章生成に使うチャンネル'), list);
      if (!guild.channels.length) body.append(node('p', `チャンネルID: ${server?.channelIds.join(', ') || '未設定'}。Bot接続後にチェックボックスで選択できます。`, 'help'));
      const measurement = state.hourly?.measurements?.[guild.id];
      if (measurement) { body.append(node('p', `${measurement.text || ''}`, 'help'), node('p', `${measurement.model || 'SLM'} · ${(measurement.elapsedMs / 1000).toFixed(2)}秒 · ${measurement.nouns?.join(' / ') || ''}`, 'help')); }
      const tools = node('div', undefined, 'row-actions');
      for (const [label, name, callback] of [['文章生成を試す', 'refresh-cw', () => this.actions.generate(guild.id)], ['このサーバーの生成文を含む時報を試す', 'play', () => this.actions.test(guild.id)], ['このサーバーの時報設定を削除', 'trash-2', () => this.actions.remove(guild.id)]]) {
        const button = node('button', undefined, 'secondary'); button.type = 'button'; button.setAttribute('data-icon-only', ''); decorateButton(button, name, label); button.disabled = !server?.enabled;
        button.addEventListener('click', async () => { button.disabled = true; try { await callback(); } catch (error) { this.actions.error(error); } finally { button.disabled = !server?.enabled; } }); tools.append(button);
      }
      body.append(tools); card.append(body); this.container.append(card);
    }
    if (!guilds.size) this.container.append(node('p', 'Botに接続すると、サーバーごとに資料チャンネルを選択できます。', 'help'));
  }
}

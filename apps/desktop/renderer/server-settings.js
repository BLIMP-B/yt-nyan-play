import { decorateButton, icon } from './icons.js';

const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};

export class ServerSettings {
  constructor(container, actions) { this.container = container; this.actions = actions; this.key = ''; }
  listen(control, event, callback) {
    control.addEventListener(event, async () => {
      try { await callback(); }
      catch (error) { this.actions.error(error); this.key = ''; this.render(this.state); }
    });
    return control;
  }
  button(label, name, callback, disabled = false) {
    const button = node('button', undefined, 'secondary');
    button.type = 'button'; button.setAttribute('data-icon-only', ''); button.disabled = disabled;
    decorateButton(button, name, label);
    if (name === 'trash-2') button.setAttribute('data-danger', '');
    return this.listen(button, 'click', callback);
  }
  checkbox(label, checked, disabled, key, callback) {
    const wrapper = node('label', undefined, 'checkbox');
    const input = node('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = disabled;
    input.dataset.focusKey = key; input.setAttribute('aria-label', label);
    wrapper.append(this.listen(input, 'change', () => callback(input.checked)), node('span', label));
    return wrapper;
  }
  render(state) {
    this.state = state;
    const key = JSON.stringify([state.bot.servers, state.bot.status, state.voices, state.config.bot.bindings, state.config.bot.masterTextChannelId, state.config.bot.announceJoinLeave]);
    if (key === this.key) return;
    this.key = key;
    const focus = this.container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
    const open = new Map([...this.container.querySelectorAll('details[data-guild]')].map(e => [e.dataset.guild, e.open]));
    this.container.replaceChildren();
    const guilds = new Map(state.bot.servers.map(guild => [guild.id, guild]));
    for (const binding of state.config.bot.bindings) if (!guilds.has(binding.guildId)) guilds.set(binding.guildId, { id: binding.guildId, name: binding.label || binding.guildId, channels: [], unavailable: true });
    for (const [index, guild] of [...guilds.values()].entries()) {
      const binding = state.config.bot.bindings.find(b => b.guildId === guild.id);
      const connection = state.voices.find(v => v.guildId === guild.id);
      const card = node('details', undefined, 'server-setting'); card.dataset.guild = guild.id;
      card.open = open.get(guild.id) ?? (Boolean(binding) || index === 0);
      const summary = node('summary');
      summary.append(node('strong', guild.name), node('span', guild.unavailable ? '未取得' : binding ? '設定済み' : '未設定', 'subtle'));
      card.append(summary);
      const body = node('div', undefined, 'server-setting-body');
      const output = node('div', undefined, 'server-output');
      const voiceLabel = node('label', 'Botの音声接続先');
      const picker = node('select'); picker.dataset.focusKey = `${guild.id}:voice`; picker.dataset.guildVoice = guild.id;
      picker.setAttribute('aria-label', `${guild.name}の音声接続先`);
      const placeholder = node('option', '音声チャンネルを選択'); placeholder.value = ''; picker.append(placeholder);
      for (const channel of guild.channels.filter(c => c.voice)) {
        const option = node('option', `${channel.parentName ? channel.parentName + ' / ' : ''}${channel.name}${channel.canConnect === false ? '（接続・発言権限なし）' : ''}`);
        option.value = channel.id; option.disabled = channel.canConnect === false; picker.append(option);
      }
      if (binding && ![...picker.options].some(o => o.value === binding.voiceChannelId)) {
        const option = node('option', `音声チャンネル ${binding.voiceChannelId}（未取得）`); option.value = binding.voiceChannelId; picker.append(option);
      }
      picker.value = binding?.voiceChannelId || ''; picker.disabled = guild.unavailable;
      this.listen(picker, 'change', () => {
        const channelId = picker.value;
        if (!channelId) { picker.value = binding?.voiceChannelId || ''; return; }
        return this.actions.update(guild, b => { b.voiceChannelId = channelId; });
      });
      voiceLabel.append(picker); output.append(voiceLabel);
      const tools = node('div', undefined, 'row-actions');
      tools.append(this.button(`${guild.name}の音声チャンネルに参加`, 'log-in', () => this.actions.join(guild.id), !binding || state.bot.status !== 'online'),
        this.button(`${guild.name}の音声チャンネルから退出`, 'log-out', () => this.actions.leave(guild.id), !connection));
      if (binding) tools.append(this.button(`${guild.name}の設定を削除`, 'trash-2', () => this.actions.remove(guild.id)));
      output.append(tools); body.append(output);
      if (connection) body.append(node('p', `接続中: ${guild.channels.find(c => c.id === connection.channelId)?.name || connection.channelId}`, 'help'));
      const switches = node('div', undefined, 'server-switches');
      const read = this.checkbox('チャットの読み上げ', binding?.readEnabled !== false && Boolean(binding), !binding, `${guild.id}:read`, value => this.actions.update(guild, b => { b.readEnabled = value; }));
      read.querySelector('input').setAttribute('aria-label', `${guild.name}のチャットを読み上げ`);
      const notify = this.checkbox('入退室・移動の読み上げ', Boolean(binding && (binding.announceJoinLeave ?? state.config.bot.announceJoinLeave)), !binding, `${guild.id}:notify`, value => this.actions.update(guild, b => { b.announceJoinLeave = value; }));
      notify.querySelector('input').setAttribute('aria-label', `${guild.name}の入退室・移動を読み上げ`);
      switches.append(read, notify);
      body.append(switches);
      if (!binding) body.append(node('p', '先に音声接続先を選択してください。選択内容は自動で保存されます。', 'help'));
      else if (binding.readEnabled === false) body.append(node('p', 'このサーバーのチャット読み上げは停止中です。チャンネルの選択は保持しています。', 'help'));
      if (binding) body.append(node('p', 'URL＋再生／無限／直接と「ていし」は、Botが閲覧できるこのサーバーの全チャンネルで受け付けます。以下のチェックは通常の読み上げ対象です。', 'help'));
      const channels = [...guild.channels];
      for (const id of new Set([...(binding?.textChannelIds || []), ...(binding ? [binding.voiceChannelId] : [])])) if (!channels.some(c => c.id === id)) channels.push({ id, name: id, text: true, voice: id === binding.voiceChannelId, unavailable: true, parentId: '__unavailable', parentName: '保存済み・未取得のチャンネル' });
      const groups = new Map();
      for (const channel of channels.filter(c => c.text !== false)) {
        const group = channel.parentId || '';
        if (!groups.has(group)) groups.set(group, { name: channel.parentName || 'カテゴリなし', channels: [] });
        groups.get(group).channels.push(channel);
      }
      const selectable = channels.filter(c => c.text !== false && c.canRead !== false && c.id !== state.config.bot.masterTextChannelId);
      const selection = node('div', undefined, 'channel-selection');
      const selectionTitle = node('strong', '読み上げるチャンネル');
      const all = this.checkbox('すべて選択', false, !binding || !selectable.length, `${guild.id}:all`, value => this.actions.update(guild, b => {
        for (const channel of selectable) {
          if (value && channel.id !== b.voiceChannelId && !b.textChannelIds.includes(channel.id)) b.textChannelIds.push(channel.id);
          b.disabledTextChannelIds = b.disabledTextChannelIds.filter(id => id !== channel.id);
          if (!value && (channel.id === b.voiceChannelId || b.textChannelIds.includes(channel.id))) b.disabledTextChannelIds.push(channel.id);
        }
      }));
      const selected = selectable.filter(c => binding && (c.id === binding.voiceChannelId || binding.textChannelIds.includes(c.id)) && !binding.disabledTextChannelIds.includes(c.id)).length;
      all.querySelector('input').checked = Boolean(selectable.length && selected === selectable.length);
      all.querySelector('input').indeterminate = selected > 0 && selected < selectable.length;
      all.querySelector('input').setAttribute('aria-label', `${guild.name}の全チャンネルを選択`);
      selection.append(selectionTitle, all); body.append(selection);
      for (const group of groups.values()) {
        const fieldset = node('fieldset', undefined, 'channel-group'); fieldset.append(node('legend', group.name));
        const list = node('div', undefined, 'channel-grid');
        for (const channel of group.channels) {
          const master = channel.id === state.config.bot.masterTextChannelId;
          const checked = master || Boolean(binding && (channel.id === binding.voiceChannelId || binding.textChannelIds.includes(channel.id)) && !binding.disabledTextChannelIds.includes(channel.id));
          const label = this.checkbox(channel.name, checked, !binding || master || channel.canRead === false, `${guild.id}:${channel.id}`, value => this.actions.update(guild, b => {
            if (value && channel.id !== b.voiceChannelId && !b.textChannelIds.includes(channel.id)) b.textChannelIds.push(channel.id);
            b.disabledTextChannelIds = b.disabledTextChannelIds.filter(id => id !== channel.id);
            if (!value) b.disabledTextChannelIds.push(channel.id);
          }));
          label.classList.add('channel-choice'); label.querySelector('input').dataset.channel = channel.id;
          label.querySelector('input').setAttribute('aria-label', `${guild.name}: ${channel.name}の読み上げ`);
          label.insertBefore(icon(channel.voice ? 'mic' : 'hash'), label.querySelector('span'));
          label.title = `${channel.name} · ${channel.id}`;
          if (master || channel.voice || channel.unavailable || channel.canRead === false) label.append(node('small', master ? 'マスタ' : channel.canRead === false ? '閲覧権限なし' : channel.unavailable ? '未取得' : 'VC内テキスト', 'subtle'));
          if (master) label.title += '（マスタチャンネルの読み上げは共通設定）';
          list.append(label);
        }
        fieldset.append(list); body.append(fieldset);
      }
      if (!groups.size) body.append(node('p', 'チャンネル一覧を取得するにはBotへ接続してください。', 'help'));
      card.append(body); this.container.append(card);
    }
    if (!guilds.size) this.container.append(node('p', 'Botに接続するとサーバーとチャンネルのチェックボックスを表示します。', 'help'));
    if (focus) [...this.container.querySelectorAll('[data-focus-key]')].find(e => e.dataset.focusKey === focus)?.focus({ preventScroll: true });
  }
}

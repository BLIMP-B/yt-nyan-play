import { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits } from 'discord.js';
import { parseBotCommand, parseMediaCommand } from '../core/protocol.mjs';
import { shouldRead, shouldReceive, prepareSpeech, formatTemplate } from '../core/text.mjs';

export class DiscordBot {
  constructor(store, handlers, clientFactory) {
    this.store = store; this.handlers = handlers; this.clientFactory = clientFactory || (() => new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages], partials: [Partials.Channel],
    }));
    this.client = null; this.status = 'offline'; this.startedAt = null; this.receiving = new Set();
  }
  async start(token) {
    if (this.client) throw new Error('Botは接続中です');
    if (typeof token !== 'string' || !token.trim()) throw new Error('Botトークンを保存してください');
    this.status = 'connecting'; this.store.emit('change');
    const client = this.clientFactory(); this.client = client;
    const safe = callback => (...args) => { Promise.resolve().then(() => callback(...args)).catch(e => this.store.log('error', e.message)); };
    client.on(Events.ClientReady, safe(async () => {
      this.status = 'online'; this.startedAt = new Date().toISOString(); this.store.log('info', 'Discord Botに接続しました');
      if (this.store.config.bot.autoJoin) for (const b of this.store.config.bot.bindings) await this.handlers.join(b.guildId);
    }));
    client.on(Events.MessageCreate, safe(message => this.message(message)));
    client.on(Events.VoiceStateUpdate, safe((previous, next) => this.voiceState(previous, next)));
    client.on(Events.ShardReconnecting, () => { this.status = 'reconnecting'; this.store.emit('change'); });
    client.on(Events.ShardResume, () => { this.status = 'online'; this.store.emit('change'); });
    client.on(Events.ShardDisconnect, () => { this.status = 'reconnecting'; this.store.emit('change'); });
    client.on(Events.Error, e => this.store.log('error', `Discord接続: ${e.message}`));
    try { await client.login(token.trim()); }
    catch { this.stop(); throw new Error('Discord Botへ接続できません。Botトークン・Intent設定・回線を確認してください'); }
  }
  stop() { this.client?.destroy(); this.client = null; this.status = 'offline'; this.handlers.disconnect?.(); this.store.emit('change'); }
  normalize(message) {
    return {
      id: message.id, content: message.content || '', userId: message.author.id,
      userName: message.author.username, displayName: message.member?.displayName || message.author.globalName || message.author.username,
      guildId: message.guildId || '', guildName: message.guild?.name || '', channelId: message.channelId, channelName: message.channel?.name || 'DM',
      webhookId: message.webhookId || '', isBot: message.author.bot, isSelf: message.author.id === this.client?.user?.id,
      isSystem: message.system, roleIds: [...(message.member?.roles.cache.keys() || [])],
      mentions: Object.fromEntries([...(message.mentions?.users || [])].map(([id, u]) => [id, u.globalName || u.username])),
      roles: Object.fromEntries([...(message.mentions?.roles || [])].map(([id, r]) => [id, r.name])),
      channels: Object.fromEntries([...(message.mentions?.channels || [])].map(([id, c]) => [id, c.name])),
      attachments: [...(message.attachments?.values() || [])].map(a => ({ name: a.name || 'ファイル', contentType: a.contentType || '', spoiler: a.spoiler === true })),
    };
  }
  async message(message) {
    if (message.author.id === this.client?.user?.id || message.system) return;
    const c = this.store.config; const normalized = this.normalize(message);
    const inBinding = c.bot.bindings.some(b => b.guildId === normalized.guildId && b.textChannelIds.includes(normalized.channelId));
    if (!inBinding && normalized.channelId !== c.bot.masterTextChannelId && !(c.bot.readDMs && !normalized.guildId)) return;
    const control = parseBotCommand(normalized.content, c.bot.prefix);
    if (control) {
      if (normalized.isBot || normalized.webhookId) return;
      if (this.store.remember(`command:${message.id}`)) return;
      const admin = c.bot.controlUserIds.includes(normalized.userId) || message.member?.permissions.has(PermissionFlagsBits.ManageGuild);
      try { await this.command(control, message, normalized, admin); } catch (e) { await this.reply(message, e.message); } return;
    }
    if (!shouldReceive(normalized, c) || this.receiving.has(message.id) || this.store.seen.includes(`message:${message.id}`)) return;
    this.receiving.add(message.id);
    try {
    const media = parseMediaCommand(normalized.content, c);
    if (media) { if (c.media.enabled) { await this.handlers.media({ ...media, master: normalized.channelId === c.bot.masterTextChannelId, guildId: normalized.guildId, source: normalized.displayName }); this.store.remember(`message:${message.id}`); } return; }
    if (!c.speech.enabled || !shouldRead(normalized, c)) return;
    const clip = c.speech.soundClips.find(s => s.trigger === normalized.content.trim());
    if (clip) { await this.handlers.speech({ clipPath: clip.path, text: clip.trigger, guildId: normalized.guildId, userId: normalized.userId }); this.store.remember(`message:${message.id}`); return; }
    const text = prepareSpeech(normalized, c);
    if (text) { await this.handlers.speech({ text, guildId: normalized.guildId, userId: normalized.userId, source: normalized.displayName }); this.store.remember(`message:${message.id}`); }
    } finally { this.receiving.delete(message.id); }
  }
  async reply(message, text) { await message.reply({ content: String(text).slice(0, 1900), allowedMentions: { parse: [], repliedUser: false } }); }
  async command(cmd, message, info, admin) {
    const c = this.store.exportConfig(); const arg = cmd.args;
    if (cmd.name === 'help') return this.reply(message, `${c.bot.prefix} help / status / speakers / voice <ID> / speed <0.5〜2> / join / leave / pause / resume / skip / stop / play <URL> / loop <URL> / read-channel <ID> on/off / dict <単語> <読み> / dict-list / dict-remove <単語>\n管理操作はサーバー管理権限または設定した操作ユーザーが利用できます。`);
    if (cmd.name === 'status') return this.reply(message, `Bot: ${this.status} / 待機: ${this.store.jobs.filter(j => j.status === 'waiting').length}`);
    if (cmd.name === 'speakers') { const speakers = await this.handlers.speakers(); return this.reply(message, speakers.flatMap(s => s.styles.map(v => `${v.id}: ${s.name}・${v.name}`)).join('\n')); }
    if (['voice', 'speed'].includes(cmd.name)) {
      const value = Number(arg[0]); if (!Number.isFinite(value)) throw new Error('声種ID・話速を指定してください');
      const profile = c.speech.profiles.find(p => p.userId === info.userId) || { userId: info.userId, name: info.displayName, styleId: c.speech.styleId, speed: c.speech.speed };
      if (cmd.name === 'voice') { const speakers = await this.handlers.speakers(); if (!speakers.some(s => s.styles.some(v => v.id === value))) throw new Error('音声エンジンにその声種がありません'); profile.styleId = value; } else profile.speed = value;
      c.speech.profiles = c.speech.profiles.filter(p => p.userId !== info.userId).concat(profile); this.store.updateConfig(c);
      return this.reply(message, 'あなたの読み上げ設定を保存しました');
    }
    if (!admin) return this.reply(message, 'この操作にはサーバー管理権限または設定済みの操作ユーザー権限が必要です');
    if (cmd.name === 'join') { await this.handlers.join(info.guildId); return this.reply(message, '設定された音声チャンネルに接続しました'); }
    if (cmd.name === 'leave') { this.handlers.leave(info.guildId); return this.reply(message, '音声チャンネルから退出しました'); }
    if (cmd.name === 'read-channel') { const id = String(arg[0] || info.channelId).replace(/[<#>]/g, ''); const binding = c.bot.bindings.find(b => b.guildId === info.guildId); if (!binding || !binding.textChannelIds.includes(id) || !['on', 'off'].includes(arg[1])) throw new Error('read-channel <登録したチャンネルID> on/off を指定してください'); binding.disabledTextChannelIds = binding.disabledTextChannelIds.filter(x => x !== id); if (arg[1] === 'off') binding.disabledTextChannelIds.push(id); this.store.updateConfig(c); return this.reply(message, `チャンネル ${id} の読み上げを ${arg[1]} にしました`); }
    if (['pause', 'resume', 'skip', 'stop'].includes(cmd.name)) { this.handlers.control(cmd.name, info.channelId === c.bot.masterTextChannelId ? 'master' : info.guildId); return this.reply(message, `再生操作: ${cmd.name}`); }
    if (['play', 'loop'].includes(cmd.name)) { if (!c.media.enabled) throw new Error('メディアの受信を無効にしています'); const media = parseMediaCommand(`${arg.join(' ')}${cmd.name === 'loop' ? '無限' : '再生'}`, c); if (!media) throw new Error('URLを指定してください'); this.handlers.media({ ...media, master: info.channelId === c.bot.masterTextChannelId, guildId: info.guildId, source: info.displayName }); return this.reply(message, '再生キューに追加しました'); }
    if (cmd.name === 'dict-list') return this.reply(message, c.dictionary.filter(d => d.scope === 'global' || d.scopeId === info.guildId).map(d => `${d.source} → ${d.replacement}`).join('\n') || '辞書は空です');
    if (cmd.name === 'dict' || cmd.name === 'dict-remove') {
      if (!arg[0] || cmd.name === 'dict' && !arg[1]) throw new Error('単語と読み方を指定してください');
      c.dictionary = c.dictionary.filter(d => !(d.source === arg[0] && d.scope === 'guild' && d.scopeId === info.guildId));
      if (cmd.name === 'dict') c.dictionary.push({ source: arg[0], replacement: arg.slice(1).join(' '), scope: 'guild', scopeId: info.guildId, regex: false });
      this.store.updateConfig(c); return this.reply(message, 'サーバー辞書を更新しました');
    }
    return this.reply(message, '未対応のコマンドです。helpで一覧を確認してください');
  }
  async voiceState(previous, next) {
    if (previous.channelId === next.channelId || next.member?.user.bot) return;
    const c = this.store.config; const binding = c.bot.bindings.find(b => b.guildId === next.guild.id); if (!binding) return;
    if (c.bot.autoJoin && next.channelId === binding.voiceChannelId) await this.handlers.join(binding.guildId);
    if (c.speech.enabled && c.bot.announceJoinLeave && next.member && !c.speech.ignoredUserIds.includes(next.id) && [previous.channelId, next.channelId].includes(binding.voiceChannelId)) {
      const template = !previous.channelId ? c.speech.joinTemplate : !next.channelId ? c.speech.leaveTemplate : c.speech.moveTemplate;
      const text = formatTemplate(template, { nickname: next.member.displayName, username: next.member.user.username, server: next.guild.name,
        channel: next.channel?.name || previous.channel?.name || '', 'channel-prev': previous.channel?.name || '', 'channel-next': next.channel?.name || '' });
      this.handlers.speech({ text, guildId: binding.guildId, userId: next.id });
    }
    const channel = next.guild.channels.cache.get(binding.voiceChannelId);
    if (c.bot.autoLeave && previous.channelId === binding.voiceChannelId && channel && !channel.members.some(m => !m.user.bot)) this.handlers.leave(binding.guildId);
  }
  catalog() {
    if (!this.client?.isReady()) return [];
    return [...this.client.guilds.cache.values()].map(g => ({ id: g.id, name: g.name,
      channels: [...g.channels.cache.values()].filter(ch => ch.isTextBased() || ch.isVoiceBased()).map(ch => ({ id: ch.id, name: ch.name, voice: ch.isVoiceBased() })) }));
  }
}

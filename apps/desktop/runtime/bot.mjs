import { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits, ActivityType } from 'discord.js';
import { parseBotCommand, parseMediaCommand } from '../core/protocol.mjs';
import { shouldRead, shouldReceive, prepareSpeech, formatTemplate } from '../core/text.mjs';
import { parseEducationCommand } from '../core/education.mjs';

export class DiscordBot {
  constructor(store, handlers, clientFactory) {
    this.store = store; this.handlers = handlers; this.clientFactory = clientFactory || (() => new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages], partials: [Partials.Channel],
    }));
    this.client = null; this.status = 'offline'; this.startedAt = null; this.receiving = new Set(); this.mediaActivity = []; this.presenceKey = null; this.emptyContentReported = false;
  }
  async start(token) {
    if (this.client) throw new Error('Botは接続中です');
    if (typeof token !== 'string' || !token.trim()) throw new Error('Botトークンを保存してください');
    this.status = 'connecting'; this.emptyContentReported = false; this.store.emit('change');
    const client = this.clientFactory(); this.client = client;
    const safe = callback => (...args) => { Promise.resolve().then(() => callback(...args)).catch(e => { if (e.name !== 'AbortError') this.store.log('error', e.message); }); };
    client.on(Events.ClientReady, safe(async () => {
      this.status = 'online'; this.startedAt = new Date().toISOString(); this.store.log('info', 'Discord Botに接続しました');
      this.presenceKey = null; this.updateMediaActivity(this.mediaActivity);
      if (this.store.config.bot.autoJoin) for (const b of this.store.config.bot.bindings) await this.handlers.join(b.guildId);
      await this.handlers.ready?.();
    }));
    client.on(Events.MessageCreate, safe(message => this.message(message)));
    client.on(Events.MessageCreate, safe(message => this.handlers.history?.(message)));
    client.on(Events.MessageUpdate, safe(async (_, message) => { if (message.partial) message = await message.fetch(); await this.handlers.history?.(message); }));
    client.on(Events.MessageDelete, safe(message => this.handlers.historyDelete?.(message.id)));
    client.on(Events.MessageBulkDelete, safe(messages => { for (const id of messages.keys()) this.handlers.historyDelete?.(id); }));
    client.on(Events.VoiceStateUpdate, safe((previous, next) => this.voiceState(previous, next)));
    for (const event of [Events.GuildCreate, Events.GuildDelete, Events.GuildUpdate, Events.ChannelCreate, Events.ChannelDelete, Events.ChannelUpdate, Events.ThreadCreate, Events.ThreadDelete, Events.ThreadUpdate, Events.GuildRoleUpdate, Events.GuildRoleDelete, Events.GuildMemberUpdate]) client.on(event, () => this.store.emit('change'));
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
    if (!normalized.content && !normalized.attachments.length && !message.stickers?.size && !normalized.isBot && !normalized.webhookId && !this.emptyContentReported && c.bot.bindings.some(b => b.guildId === normalized.guildId)) {
      this.emptyContentReported = true;
      this.store.log('warn', 'Discordから本文が空のメッセージを受信しました。URL再生命令も届かない場合は、Developer PortalのBot設定でMESSAGE CONTENT INTENTを有効にし、Botを再接続してください');
    }
    const inBinding = c.bot.bindings.some(b => b.guildId === normalized.guildId && (b.voiceChannelId === normalized.channelId || b.textChannelIds.includes(normalized.channelId)));
    const isReadChannel = inBinding || normalized.channelId === c.bot.masterTextChannelId || c.bot.readDMs && !normalized.guildId;
    const mediaText = normalized.content.trim();
    const mediaRequest = mediaText.startsWith('NYANPLAY/1 ') || /^<?https?:\/\/[\s\S]+(?:再生|無限|直接)(?:\s|$)/.test(mediaText);
    const mediaControl = mediaRequest || mediaText === 'ていし';
    // Media commands belong to the server's VC, independently of speech checkboxes.
    if (!isReadChannel && !(mediaControl && c.bot.bindings.some(b => b.guildId === normalized.guildId))) {
      if (mediaRequest) this.store.log('warn', `メディア要求を受信しましたが、サーバー ${normalized.guildId} のVC設定がありません。「Discord接続」で接続先を設定してください`);
      return;
    }
    const control = parseBotCommand(normalized.content, c.bot.prefix);
    if (control) {
      if (normalized.isBot || normalized.webhookId) return;
      if (this.store.remember(`command:${message.id}`)) return;
      const admin = c.bot.controlUserIds.includes(normalized.userId) || message.member?.permissions.has(PermissionFlagsBits.ManageGuild);
      try { await this.command(control, message, normalized, admin); } catch (e) { await this.reply(message, e.message); } return;
    }
    if (!shouldReceive(normalized, c, mediaControl) || this.receiving.has(message.id) || this.store.seen.includes(`message:${message.id}`)) return;
    this.receiving.add(message.id);
    try {
    if (normalized.content.trim() === 'ていし') {
      await this.handlers.stopRequested({ guildId: normalized.guildId, master: normalized.channelId === c.bot.masterTextChannelId });
      this.store.remember(`message:${message.id}`); return;
    }
    let media;
    try { media = parseMediaCommand(normalized.content, c); }
    catch (error) { this.store.log('error', `メディア要求: ${error.message}`); if (!normalized.isBot && !normalized.webhookId) await this.reply(message, error.message); return; }
    if (media) {
      if (c.media.enabled) {
        await this.handlers.media({ ...media, master: normalized.channelId === c.bot.masterTextChannelId, guildId: normalized.guildId, source: normalized.displayName });
        this.store.remember(`message:${message.id}`);
        this.store.log('info', `メディア要求をキューに追加しました: サーバー ${normalized.guildId} / チャンネル ${normalized.channelId} / ${media.mode}`);
      } else this.store.log('warn', 'メディア要求を受信しましたが、設定でメディアの受信が無効になっています');
      return;
    }
    if (!isReadChannel) return;
    if (!c.speech.enabled || !shouldRead(normalized, c)) return;
    if (c.speech.chatEducationEnabled) {
      try {
        const education = parseEducationCommand(normalized.content);
        if (education) {
          const result = await this.handlers.education(education);
          this.store.remember(`message:${message.id}`);
          if (result.text) await this.handlers.speech({ text: result.text, guildId: normalized.guildId, userId: normalized.userId, source: normalized.displayName, literal: true });
          await this.reply(message, result.text || '教育辞書を更新しました'); return;
        }
      } catch (e) { this.store.log('error', e.message); this.store.remember(`message:${message.id}`); await this.reply(message, e.message); return; }
    }
    const clip = c.speech.soundClips.find(s => s.trigger === normalized.content.trim());
    if (clip) { await this.handlers.speech({ clipPath: clip.path, text: clip.trigger, guildId: normalized.guildId, userId: normalized.userId }); this.store.remember(`message:${message.id}`); return; }
    const text = prepareSpeech(normalized, c);
    if (text) { await this.handlers.speech({ text, guildId: normalized.guildId, userId: normalized.userId, source: normalized.displayName }); this.store.remember(`message:${message.id}`); }
    } finally { this.receiving.delete(message.id); }
  }
  async reply(message, text) { await message.reply({ content: String(text).slice(0, 1900), allowedMentions: { parse: [], repliedUser: false } }); }
  async command(cmd, message, info, admin) {
    const c = this.store.exportConfig(); const arg = cmd.args;
    if (cmd.name === 'help') return this.reply(message, `${c.bot.prefix} help / status / speakers / voice <ID> / speed <0.5〜2> / join / leave / pause / resume / skip / stop / play <URL> / loop <URL> / direct <URL> / read-channel <ID> on/off / dict <単語> <読み> / dict-list / dict-remove <単語>\nURL再生＝告知後45秒、URL無限＝告知後1回全編、URL直接＝告知なし1回全編。ていし＝優先停止。\n管理操作はサーバー管理権限または設定した操作ユーザーが利用できます。`);
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
    if (cmd.name === 'read-channel') { const id = String(arg[0] || info.channelId).replace(/[<#>]/g, ''); const binding = c.bot.bindings.find(b => b.guildId === info.guildId); if (!binding || !(binding.voiceChannelId === id || binding.textChannelIds.includes(id)) || !['on', 'off'].includes(arg[1])) throw new Error('read-channel <登録したチャンネルID> on/off を指定してください'); binding.disabledTextChannelIds = binding.disabledTextChannelIds.filter(x => x !== id); if (arg[1] === 'off') binding.disabledTextChannelIds.push(id); this.store.updateConfig(c); return this.reply(message, `チャンネル ${id} の読み上げを ${arg[1]} にしました`); }
    if (['pause', 'resume', 'skip', 'stop'].includes(cmd.name)) { this.handlers.control(cmd.name, info.channelId === c.bot.masterTextChannelId ? 'master' : info.guildId); return this.reply(message, `再生操作: ${cmd.name}`); }
    if (['play', 'loop', 'direct'].includes(cmd.name)) { if (!c.media.enabled) throw new Error('メディアの受信を無効にしています'); const media = parseMediaCommand(`${arg.join(' ')}${{ play: '再生', loop: '無限', direct: '直接' }[cmd.name]}`, c); if (!media) throw new Error('URLを指定してください'); this.handlers.media({ ...media, master: info.channelId === c.bot.masterTextChannelId, guildId: info.guildId, source: info.displayName }); return this.reply(message, '再生キューに追加しました'); }
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
    if (c.speech.enabled && (binding.announceJoinLeave ?? c.bot.announceJoinLeave) && next.member && !c.speech.ignoredUserIds.includes(next.id) && [previous.channelId, next.channelId].includes(binding.voiceChannelId)) {
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
      channels: [...g.channels.cache.values()].filter(ch => ch.isTextBased() || ch.isVoiceBased()).map(ch => {
        const permission = ch.permissionsFor(this.client.user);
        const visible = Boolean(permission?.has(PermissionFlagsBits.ViewChannel));
        return { id: ch.id, name: ch.name, voice: ch.isVoiceBased(), text: ch.isTextBased(),
          parentId: ch.parentId || '', parentName: ch.parent?.name || '', position: ch.rawPosition ?? ch.position ?? 0,
          parentPosition: ch.parent?.rawPosition ?? ch.parent?.position ?? 0,
          canRead: visible && ch.isTextBased(), canHistory: visible && ch.isTextBased() && Boolean(permission?.has(PermissionFlagsBits.ReadMessageHistory)), canConnect: visible && ch.isVoiceBased() && Boolean(permission?.has(PermissionFlagsBits.Connect | PermissionFlagsBits.Speak)) };
      }).sort((a, b) => a.parentPosition - b.parentPosition || a.position - b.position || a.name.localeCompare(b.name, 'ja')) }));
  }
  updateMediaActivity(items) {
    this.mediaActivity = items;
    if (!this.client?.user?.setPresence || this.status !== 'online') return;
    const active = items.filter(i => i.startedAt && i.title).sort((a, b) => Number(b.scope === 'master') - Number(a.scope === 'master') || b.startedAt - a.startedAt)[0];
    const name = active ? [...`${active.paused ? '一時停止：' : ''}${active.service}：${active.title}`].slice(0, 128).join('') : '';
    const key = `${name}:${active?.audioOnly || false}`; if (this.presenceKey === key) return;
    this.client.user.setPresence({ status: 'online', activities: active ? [{ name, type: active.audioOnly ? ActivityType.Listening : ActivityType.Watching }] : [] }); this.presenceKey = key;
  }
}

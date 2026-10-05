import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { writeAtomic } from '../core/store.mjs';
import { hourlyProgram, hourPhrase, nextHour } from '../core/hourly-audio.mjs';
import { generateSlm } from '../core/hourly-language.mjs';

export class HourlyRuntime extends EventEmitter {
  constructor(directory, getConfig, handlers, { now = Date.now, delay = (ms, signal) => wait(ms, undefined, { signal }) } = {}) {
    super(); this.getConfig = getConfig; this.handlers = handlers; this.now = now; this.delay = delay;
    this.file = join(directory, 'hourly-plans.json'); this.saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file)) : { lastHour: 0, plans: {}, measurements: {} };
    this.active = null; this.preparing = null; this.prepared = null; this.batches = new Map(); this.controller = null; this.phase = '停止中'; this.error = ''; this.nextAt = null;
  }
  changed() { this.emit('change'); }
  save() { const cutoff = this.now() - 2 * 86400000; for (const [key, plan] of Object.entries(this.saved.plans)) if (plan.at < cutoff) delete this.saved.plans[key]; writeAtomic(this.file, this.saved); this.changed(); }
  key(server, at) { return `${server.guildId}:${at}:${JSON.stringify([server.channelIds, this.getConfig().hourly.slmModel])}`; }
  mode(server, budgetMs = 7000) { const c = this.getConfig().hourly; return c.generationMode === 'auto' ? (this.saved.measurements[server.guildId]?.daily || this.saved.measurements[server.guildId]?.elapsedMs > budgetMs ? 'daily' : 'live') : c.generationMode; }
  snapshot() { return { phase: this.phase, active: this.active, busy: Boolean(this.active || this.preparing || this.testing), nextAt: this.nextAt, error: this.error, measurements: this.saved.measurements, batches: [...this.batches.keys()] }; }
  start() { if (!this.timer) { this.timer = setInterval(() => this.tick(), 500); this.timer.unref(); } this.tick(); }
  tick() {
    if (!this.getConfig().hourly.enabled || this.active || this.testing) { if (!this.getConfig().hourly.enabled && !this.active && !this.testing) this.phase = '停止中'; return; }
    const at = nextHour(this.now()); this.nextAt = at;
    if (at !== this.lastNext) { this.lastNext = at; this.phase = '次の正時を待機'; this.changed(); }
    if (this.now() >= at - 60000 && this.prepared?.thirdAt !== at && this.preparing !== at && this.saved.lastHour < at && this.attempted !== at) {
      this.preparing = at; const controller = this.controller ||= new AbortController();
      void this.prepare(at, controller.signal).then(program => { if (!controller.signal.aborted) this.prepared = program; }).catch(error => { this.attempted = at; this.failed(error); }).finally(() => { this.preparing = null; });
    }
    if (this.prepared?.thirdAt === at && this.now() >= this.prepared.startAt - this.getConfig().hourly.fadeMs) {
      const program = this.prepared; this.prepared = null; this.attempted = at;
      void this.execute(program).catch(error => this.failed(error));
    }
  }
  failed(error) { if (error.name !== 'AbortError') { this.error = error.message; this.handlers.log('error', `時報: ${error.message}`); this.changed(); } }
  async until(at, signal) { while (this.now() < at) { signal?.throwIfAborted(); await this.delay(Math.min(250, at - this.now()), signal); } signal?.throwIfAborted(); }
  async generate(server, cutoff, signal) {
    const began = performance.now(); await this.handlers.model.start(signal);
    const model = await this.handlers.history.model(server, cutoff, signal);
    const result = await (this.handlers.generate || generateSlm)(model, this.getConfig().hourly, signal, this.handlers.fetcher);
    const elapsedMs = Math.round(performance.now() - began); this.saved.measurements[server.guildId] = { daily: this.saved.measurements[server.guildId]?.daily || false, elapsedMs, model: result.model, cutoff, text: result.text, nouns: result.nouns };
    this.save(); return { ...result, elapsedMs, cutoff };
  }
  async batch(server, firstAt, signal, first) {
    const date = new Date(firstAt), key = `${server.guildId}:${date.getFullYear()}-${date.getMonth()}-${date.getDate()}:${JSON.stringify([server.channelIds, this.getConfig().hourly.slmModel])}`;
    if (this.saved.batchDays?.[key]) return;
    if (this.batches.has(key)) return this.batches.get(key);
    const task = (async () => {
      const cutoff = this.now(); const slots = [firstAt];
      for (let hour = 0; hour < 24; hour++) { const slot = new Date(firstAt); slot.setHours(hour, 0, 0, 0); if (!slots.includes(slot.getTime())) slots.push(slot.getTime()); }
      for (const [i, at] of slots.entries()) {
        signal?.throwIfAborted(); const id = this.key(server, at); if (this.saved.plans[id]) continue;
        const result = i === 0 && first ? first : await this.generate(server, cutoff, signal);
        this.saved.plans[id] = { ...result, at }; this.save();
      }
      this.saved.batchDays ||= {}; this.saved.batchDays[key] = cutoff;
      for (const [day, time] of Object.entries(this.saved.batchDays)) if (time < this.now() - 2 * 86400000) delete this.saved.batchDays[day]; this.save();
    })(); this.batches.set(key, task); this.changed();
    try { await task; } finally { this.batches.delete(key); this.changed(); }
  }
  async prepare(at, signal) {
    const text = hourPhrase(at); this.phase = '時報音声を準備中'; this.error = ''; this.changed();
    const pcm = await this.handlers.synthesize(text, signal); const program = { ...hourlyProgram(pcm, at), text };
    // Model preparation never blocks the common announcement or its exact beep schedule.
    for (const server of this.getConfig().hourly.servers.filter(s => s.enabled)) {
      if (this.mode(server, at + 1000 - program.startAt) === 'daily') void this.batch(server, at, signal).catch(error => this.failed(error));
      else if (!this.saved.measurements[server.guildId]) void this.generate(server, this.now(), signal).then(result => {
        if (this.getConfig().hourly.generationMode === 'auto' && result.elapsedMs > at + 1000 - program.startAt) { this.saved.measurements[server.guildId].daily = true; this.save(); return this.batch(server, at, signal, result); }
      }).catch(error => this.failed(error));
    }
    this.phase = '正時に合わせて再生を予約'; this.changed(); return program;
  }
  async sentence(server, at, budgetMs, signal) {
    if (this.mode(server, budgetMs) === 'daily') {
      const plan = this.saved.plans[this.key(server, at)]; if (!plan) throw new Error('この時刻の事前生成文がまだ準備できていません'); return plan;
    }
    return this.generate(server, this.now(), signal);
  }
  async execute(program, { test = false, guildId = '' } = {}) {
    if (this.active) throw new Error('時報を再生中です');
    if (this.now() > program.startAt + 250) throw new Error('時報の準備が間に合いませんでした。遅れた時報は再生しません');
    const controller = this.controller ||= new AbortController(), signal = controller.signal;
    const c = this.getConfig().hourly; const all = c.output === 'local' ? [] : this.handlers.targets();
    if (c.output !== 'local' && !all.length) throw new Error('共通時報を流すVCへBotを接続してください');
    const servers = this.getConfig().hourly.servers.filter(s => s.enabled && (!guildId || s.guildId === guildId) && (c.output === 'local' || all.includes(s.guildId)));
    this.active = { text: program.text, hourAt: program.thirdAt, startAt: program.startAt, thirdAt: program.thirdAt, test, servers: [] }; this.changed();
    let release = this.handlers.reserve(); const held = new Set(all); const customReleases = new Map();
    try {
      for (const id of all) this.handlers.hold(id, true);
      this.handlers.fadeMedia(c.mediaGain, c.fadeMs); this.phase = '共通時報'; this.changed();
      if (!test) { this.saved.lastHour = program.thirdAt; this.save(); }
      const playback = this.handlers.play(program.pcm, all, signal, program.startAt).then(() => ({}), error => ({ error }));
      await this.until(program.startAt, signal);
      const budgetMs = program.thirdAt + 1000 - program.startAt;
      const sentences = new Map(servers.map(server => [server.guildId, this.sentence(server, program.thirdAt, budgetMs, signal).then(value => ({ value }), error => ({ error }))]));
      const played = await playback; if (played.error) throw played.error;
      for (const server of servers) customReleases.set(server.guildId, this.handlers.reserve([server.guildId, 'master', 'local']));
      release(); release = null;
      for (const id of all) if (!servers.some(s => s.guildId === id)) { this.handlers.hold(id, false); held.delete(id); }
      this.handlers.fadeMedia(1, c.fadeMs);
      for (const server of servers) this.handlers.fadeMedia(c.mediaGain, c.fadeMs, server.guildId);
      const customBody = async server => {
        const result = await Promise.race([sentences.get(server.guildId), this.delay(100, signal).then(() => ({ timedOut: true, error: new Error('SLM生成が時報内の時間に収まりませんでした。事前生成へ切り替えます') }))]);
        if (result.error) {
          if (c.generationMode === 'auto' && result.timedOut) { this.saved.measurements[server.guildId] = { ...(this.saved.measurements[server.guildId] || {}), daily: true, elapsedMs: Math.max(budgetMs + 1, this.saved.measurements[server.guildId]?.elapsedMs || 0) }; this.save(); void this.batch(server, nextHour(program.thirdAt), signal).catch(error => this.failed(error)); }
          this.handlers.log('warn', `時報の生成文 (${server.guildId}): ${result.error.message}`); return;
        }
        const sentence = result.value; const entry = { guildId: server.guildId, text: sentence.text, nouns: sentence.nouns, cutoff: sentence.cutoff, elapsedMs: sentence.elapsedMs, phase: '生成文の読み上げ' }; this.active.servers.push(entry); this.phase = 'サーバー別時報'; this.changed();
        let background;
        try {
          const spoken = await this.handlers.synthesize(sentence.text, signal);
          if (server.bgm) { try { background = await this.handlers.background(sentence.nouns, server.guildId, signal); } catch (error) { signal.throwIfAborted(); this.handlers.log('warn', `時報BGM (${server.guildId}): ${error.message}`); } }
          await this.handlers.play(spoken, c.output === 'local' ? [] : [server.guildId], signal);
          if (background) { entry.phase = 'BGMの余韻・フェードアウト'; this.changed(); await this.delay(1500, signal); await background.fade(1500, signal); }
        } finally { await background?.stop(); entry.phase = '完了'; this.changed(); }
      };
      const runCustom = async server => { try { await customBody(server); } finally {
        this.handlers.fadeMedia(1, c.fadeMs, server.guildId);
        if (held.has(server.guildId)) { this.handlers.hold(server.guildId, false); held.delete(server.guildId); }
        customReleases.get(server.guildId)?.(); customReleases.delete(server.guildId);
      } };
      // A single PC speaker cannot isolate multiple server overlays; Discord remains parallel.
      if (c.output === 'local' || c.output === 'both') { for (const server of servers) await runCustom(server); }
      else { const results = await Promise.allSettled(servers.map(runCustom)); for (const result of results) if (result.status === 'rejected') this.failed(result.reason); }
    } finally {
      release?.(); for (const releaseCustom of customReleases.values()) releaseCustom();
      for (const id of held) this.handlers.hold(id, false);
      this.handlers.fadeMedia(1, c.fadeMs); for (const server of servers) this.handlers.fadeMedia(1, c.fadeMs, server.guildId);
      this.active = null; this.phase = this.getConfig().hourly.enabled ? '次の正時を待機' : '停止中'; this.changed();
    }
  }
  async test(guildId = '') {
    if (this.active || this.preparing || this.testing) throw new Error('時報を準備・再生中です'); this.testing = true; this.changed();
    const controller = this.controller ||= new AbortController();
    try { const at = this.now() + 15000; const program = await this.prepare(at, controller.signal); await this.until(program.startAt - this.getConfig().hourly.fadeMs, controller.signal); return await this.execute(program, { test: true, guildId }); }
    finally { this.testing = false; this.changed(); }
  }
  cancel() { this.controller?.abort(new DOMException('時報を中止しました', 'AbortError')); this.controller = null; this.prepared = null; }
  update() { if (!this.getConfig().hourly.enabled) this.cancel(); this.nextAt = nextHour(this.now()); this.changed(); }
  close() { clearInterval(this.timer); this.cancel(); }
}

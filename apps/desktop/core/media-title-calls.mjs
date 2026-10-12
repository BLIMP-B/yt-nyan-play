import { setTimeout as delay } from 'node:timers/promises';
import { mediaAnnouncement } from './protocol.mjs';
import { titleChoice } from './media-title.mjs';

export class MediaTitleCalls {
  constructor(getConfig, { metadata, speak, log = () => {} }) { this.getConfig = getConfig; this.metadata = metadata; this.speak = speak; this.log = log; this.active = new Map(); }
  started(id) { const entry = this.active.get(id); if (entry) { entry.started = true; entry.ready(); } }
  update(id, values) { const entry = this.active.get(id); if (entry) { for (const key of ['title', 'body', 'author']) if (values[key]) entry.metadata[key] = values[key]; if (titleChoice(entry.payload, entry.metadata).source !== 'pending') entry.ready(); } }
  async play(job, signal, playback) {
    signal.throwIfAborted();
    const controller = new AbortController(), speechSignal = AbortSignal.any([signal, controller.signal]);
    const enabled = this.getConfig().media.titleCallEnabled;
    let ready; const prepared = new Promise(resolve => { ready = resolve; });
    const entry = { started: false, metadata: {}, payload: job.payload, ready }; this.active.set(job.id, entry);
    speechSignal.addEventListener('abort', ready, { once: true });
    const payload = { guildId: job.payload.guildId, master: job.payload.master, system: true, output: this.getConfig().media.output };
    if (enabled && titleChoice(job.payload).source !== 'message') Promise.resolve().then(() => this.metadata(job.payload.url, speechSignal)).then(values => { if (this.active.get(job.id) === entry) this.update(job.id, values); }).catch(error => { if (!speechSignal.aborted) this.log('info', 'タイトル情報を取得できないため別の情報で案内します'); }).finally(ready);
    else ready();
    let call;
    try {
      if (job.payload.mode !== 'direct') await this.speak({ ...payload, text: mediaAnnouncement(job.payload.url), priority: 50 }, { signal: speechSignal, interrupt: true });
      signal.throwIfAborted();
      // Start both paths without waiting for title synthesis or metadata.
      const playing = Promise.resolve().then(playback);
      call = enabled ? (async () => {
        // Allow a short metadata head start, then fill a slow lookup gap.
        await Promise.race([prepared, delay(750, undefined, { signal: speechSignal })]);
        while (!entry.started && !speechSignal.aborted) {
          const choice = titleChoice(job.payload, entry.metadata);
          await this.speak({ ...payload, text: choice.text, titleCall: true, priority: 45 }, { signal: speechSignal });
          if (choice.source !== 'pending' || entry.started) break;
          await delay(100, undefined, { signal: speechSignal });
        }
      })().catch(error => { if (!speechSignal.aborted && error.name !== 'AbortError') this.log('warn', `タイトルコール: ${error.message}`); }) : Promise.resolve();
      await playing; entry.started = true; ready();
      // Natural media end also lets the current spoken unit finish. Replacing
      // or stopping the job aborts it through the parent signal instead.
      await call;
    } finally { controller.abort(); await call; this.active.delete(job.id); }
  }
}

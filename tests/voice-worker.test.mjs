import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyVoiceClock } from '../scripts/voice-clock-probe.mjs';
import { DiscordAudioWorker } from '../apps/desktop/runtime/voice-worker.mjs';

test('real audio worker keeps speech and browser PCM UDP packets steady while the app thread stalls', { timeout: 20000 }, async () => {
  const report = await verifyVoiceClock(); assert.equal(report.passed, true);
});
test('production audio worker loads its codec, stops and starts a fresh thread', { timeout: 10000 }, async () => {
  const backend = new DiscordAudioWorker();
  try {
    const first = await backend.health(); assert.ok(first.threadId > 0); assert.equal(first.packetBytes, 120); assert.equal(first.pcmBytes, 3840);
    backend.close(); assert.equal(backend.pending.size, 0);
    const second = await backend.health(); assert.notEqual(second.threadId, first.threadId); assert.equal(second.pcmBytes, 3840);
  } finally { backend.close(); }
});

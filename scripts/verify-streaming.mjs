import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MediaStreamResolver } from '../apps/desktop/runtime/media-streams.mjs';
import { MEDIA_EXTRACTOR } from '../apps/desktop/core/media-streams.mjs';
const directory = mkdtempSync(join(tmpdir(), 'nyan-extractor-'));
try {
  const resolver = new MediaStreamResolver(directory, (_level, text) => console.log(text), fetch, async () => []);
  const executable = await resolver.install();
  const version = execFileSync(executable, ['--version'], { windowsHide: true, timeout: 30000 }).toString().trim();
  assert.equal(version, MEDIA_EXTRACTOR.version);
  const report = { passed: true, version, sha256Verified: true, actualServiceAudio: false };
  const reports = resolve('dist/streaming-verification'); mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, 'extractor-report.json'), JSON.stringify(report, null, 2));
  console.log('STREAMING_TOOL_VERIFIED', JSON.stringify(report));
} finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }

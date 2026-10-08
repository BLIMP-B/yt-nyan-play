import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { verifyVoiceClock } from './voice-clock-probe.mjs';

const directory = resolve('dist/voice-clock-verification'); mkdirSync(directory, { recursive: true });
const report = { platform: process.platform, passed: false };
try { Object.assign(report, await verifyVoiceClock()); }
catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { writeFileSync(join(directory, 'clock-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }

import { mkdirSync, writeFileSync } from 'node:fs';
import { verifyVoiceImpairments } from './voice-impairment-probe.mjs';
mkdirSync('dist/voice-impairment-verification', { recursive: true });
let report;
try { report = { platform: process.platform, ...await verifyVoiceImpairments() }; }
catch (error) { report = { platform: process.platform, passed: false, error: error.stack }; process.exitCode = 1; }
writeFileSync('dist/voice-impairment-verification/impairment-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ platform: report.platform, passed: report.passed, error: report.error, sourceBaseline: report.sourceBaseline?.summaries, sourceFixed: report.sourceFixed?.summaries, pacingBaseline: report.pacingBaseline?.summaries, pacingFixed: report.pacingFixed?.summaries }));

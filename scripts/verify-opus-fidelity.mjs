import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { verifyOpusFidelity } from './opus-fidelity-probe.mjs';
const report = await verifyOpusFidelity({ includeLegacy: true });
const directory = resolve(import.meta.dirname, '../dist/opus-fidelity-verification'); mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, `opus-fidelity-${process.platform}-report.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;

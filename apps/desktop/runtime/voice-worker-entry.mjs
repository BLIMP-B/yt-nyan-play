import { parentPort } from 'node:worker_threads';
import { VoiceWorkerRuntime } from './voice-worker-runtime.mjs';

new VoiceWorkerRuntime(parentPort);

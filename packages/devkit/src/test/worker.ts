import { pathToFileURL } from 'node:url';
import { run, serializeError, type TestResult } from './index.js';

/**
 * Runs one test file in its own process and sends each result to the
 * runner over IPC. The process exits when the file is done, so a server a
 * test forgot to close cannot hang the run.
 */
export type WorkerMessage = { type: 'result'; result: TestResult } | { type: 'file-error'; error: ReturnType<typeof serializeError> } | { type: 'done' };

const [file, filter, timeout, hookTimeout] = process.argv.slice(2) as [string, string, string, string];
const send = (m: WorkerMessage) => new Promise<void>((r) => (process.send ? process.send(m, () => r()) : (console.log(JSON.stringify(m)), r())));
const pending: Promise<void>[] = [];

process.on('uncaughtException', (e) => void pending.push(send({ type: 'file-error', error: serializeError(e) })));
process.on('unhandledRejection', (e) => void pending.push(send({ type: 'file-error', error: serializeError(e) })));

try {
  await import(pathToFileURL(file).href);
  await run({
    filter: filter ? new RegExp(filter) : undefined,
    timeout: Number(timeout),
    hookTimeout: Number(hookTimeout),
    onResult: (result) => void pending.push(send({ type: 'result', result })),
  });
} catch (e) {
  pending.push(send({ type: 'file-error', error: serializeError(e) }));
}
await Promise.all(pending);
await send({ type: 'done' });
process.exit(0);

/**
 * Runs the core (proxy, MQTT relays, capture database, core API) in an
 * Electron utility process, so heavy traffic never blocks the window.
 * The main process sends {type:'start'} and later {type:'close'}.
 */
import { Core } from '@siteinquisition/core';

interface StartMessage {
  type: 'start';
  projectDir: string;
  proxyPort?: number;
  allowLan?: boolean;
}

type Message = StartMessage | { type: 'close' };

const port = process.parentPort;
let core: Core | undefined;

port.on('message', (e: { data: Message }) => {
  const msg = e.data;
  if (msg.type === 'start') void start(msg);
  if (msg.type === 'close') void close();
});

async function start(msg: StartMessage) {
  try {
    const open = (proxyPort: number) => Core.open({ projectDir: msg.projectDir, proxy: { port: proxyPort, allowLan: msg.allowLan ?? false }, api: {} });
    core = await open(msg.proxyPort ?? 8080);
    let ports;
    try {
      ports = await core.start();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      // The usual port is taken (often by another proxy): let the OS pick one; the title bar shows it.
      await core.close();
      core = await open(0);
      ports = await core.start();
    }
    port.postMessage({ type: 'ready', proxyPort: ports.proxyPort, apiPort: ports.apiPort, token: core.api!.token });
  } catch (err) {
    port.postMessage({ type: 'error', message: (err as Error).message });
  }
}

async function close() {
  try {
    await core?.close();
  } finally {
    port.postMessage({ type: 'closed' });
    process.exit(0);
  }
}

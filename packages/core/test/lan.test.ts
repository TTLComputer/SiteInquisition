import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core, LanGate, parseRange } from '@siteinquisition/core';

describe('LAN allow list', () => {
  it('parses addresses and ranges, and matches them', () => {
    expect(() => parseRange('300.1.1.1')).toThrow(/not an IP/);
    expect(() => parseRange('10.0.0.0/33')).toThrow(/prefix/);
    const gate = new LanGate(true, ['192.168.1.0/24', '10.0.0.7', 'fd00::/8']);
    expect(gate.accept('192.168.1.200', 'proxy')).toBe(true);
    expect(gate.accept('::ffff:192.168.1.9', 'proxy')).toBe(true);
    expect(gate.accept('192.168.2.1', 'proxy')).toBe(false);
    expect(gate.accept('10.0.0.7', 'proxy')).toBe(true);
    expect(gate.accept('10.0.0.8', 'proxy')).toBe(false);
    expect(gate.accept('fd12:3456::1', 'proxy')).toBe(true);
    expect(gate.accept('fe80::1', 'proxy')).toBe(false);
    expect(gate.accept('127.0.0.1', 'proxy')).toBe(true);
    expect(gate.accept('::1', 'proxy')).toBe(true);
  });

  it('lists refused devices once each, lets them in when allowed, and forgets denied ones', () => {
    const gate = new LanGate(true);
    const seen: string[] = [];
    gate.on('pending', (p) => seen.push(p.address));
    expect(gate.accept('::ffff:192.168.5.5', 'proxy')).toBe(false);
    expect(gate.accept('192.168.5.5', 'mqtt :1883')).toBe(false);
    expect(gate.accept('192.168.5.6', 'proxy')).toBe(false);
    expect(seen).toEqual(['192.168.5.5', '192.168.5.6']);
    expect(gate.pending().map((p) => [p.address, p.attempts])).toEqual([
      ['192.168.5.5', 2],
      ['192.168.5.6', 1],
    ]);
    gate.allow('::ffff:192.168.5.5');
    expect(gate.allowed).toEqual(['192.168.5.5']);
    expect(gate.accept('192.168.5.5', 'proxy')).toBe(true);
    gate.deny('192.168.5.6');
    expect(gate.pending()).toEqual([]);
    expect(gate.accept('192.168.5.6', 'proxy')).toBe(false);
    expect(gate.pending()).toEqual([]);
    gate.remove('192.168.5.5');
    expect(gate.accept('192.168.5.5', 'proxy')).toBe(false);
  });

  it('lets nobody but loopback in when LAN access is off', () => {
    const gate = new LanGate(false, ['0.0.0.0/0']);
    expect(gate.accept('192.168.1.1', 'proxy')).toBe(false);
    expect(gate.pending()).toEqual([]);
    expect(gate.accept('127.0.0.1', 'proxy')).toBe(true);
  });
});

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

/** Send one request through the proxy from `host`; resolve with the status line, '' when the proxy hung up, or the error code. */
const tryProxy = (port: number, host: string, target: string) =>
  new Promise<string>((resolve) => {
    const sock = connect(port, host, () => sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let got = '';
    sock.on('data', (d) => (got += d.toString()));
    sock.on('close', () => resolve(got.split('\r\n')[0] ?? ''));
    sock.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
  });

describe.skipIf(!lanAddress)('proxy listeners and LAN clients', () => {
  let dir: string;
  let upstream: Server;
  let target: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'siq-lan-'));
    upstream = createServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`;
  });
  afterAll(() => {
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('listens on loopback only without --lan', async () => {
    const core = await Core.open({ projectDir: join(dir, 'a'), dataDir: join(dir, 'data'), api: false, proxy: { port: 0 } });
    try {
      await core.start();
      expect(await tryProxy(core.proxy.port, lanAddress!, target)).toBe('ECONNREFUSED');
      expect(await tryProxy(core.proxy.port, '127.0.0.1', target)).toBe('HTTP/1.1 200 OK');
    } finally {
      await core.close();
    }
  });

  it('with --lan, refuses a new device until it is allowed, and remembers the allow list', async () => {
    const open = () => Core.open({ projectDir: join(dir, 'b'), dataDir: join(dir, 'data'), api: false, proxy: { port: 0, allowLan: true } });
    let core = await open();
    try {
      await core.start();
      // Refused without an answer: a clean close, or a reset on Windows, which
      // resets a socket closed with the request still unread.
      expect(['', 'ECONNRESET']).toContain(await tryProxy(core.proxy.port, lanAddress!, target));
      expect(core.lanState().pending.map((p) => p.address)).toEqual([lanAddress]);
      core.lan.allow(lanAddress!);
      expect(await tryProxy(core.proxy.port, lanAddress!, target)).toBe('HTTP/1.1 200 OK');
    } finally {
      await core.close();
    }
    core = await open();
    try {
      expect(core.lanState()).toMatchObject({ enabled: true, allowed: [lanAddress], pending: [] });
    } finally {
      await core.close();
    }
  });
});

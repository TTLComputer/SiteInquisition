/**
 * Seeded fuzzing for the parsers that read bytes from the network or from
 * files the user imports. Each must, for any input, either return or throw
 * its own error type: no TypeError or RangeError from inside, no hang. The
 * seed is fixed so a failure reproduces; set SIQ_FUZZ_SEED to explore.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from '@siteinquisition/devkit/test';
import { decodeGrpc, decodeProtobuf, decodeSignalR, decodeSocketIO, decodeViewState, detectChain, summarizeFrame } from '@siteinquisition/codecs';
import { YamlError, parseYaml } from '@siteinquisition/core';
import { MqttError, MqttParser } from '../src/mqttcodec.js';
import { VECTORS } from './mqtt-vectors.js';
import { QpackDecoder, QpackEncoder, QpackError } from '../src/quic/qpack.js';

const SEED = Number(process.env.SIQ_FUZZ_SEED ?? 20261104);
const ROUNDS = Number(process.env.SIQ_FUZZ_ROUNDS ?? 1500);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random bytes, or a valid sample with bytes flipped, cut, repeated or inserted. */
function inputs(seed: number, samples: Uint8Array[], n = ROUNDS): Uint8Array[] {
  const r = rng(seed);
  const int = (m: number) => Math.floor(r() * m);
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    if (!samples.length || r() < 0.25) {
      out.push(Uint8Array.from({ length: int(64) }, () => int(256)));
      continue;
    }
    const b = Array.from(samples[int(samples.length)]!);
    for (let k = 0, edits = 1 + int(4); k < edits; k++) {
      const op = int(5);
      const at = int(b.length + 1);
      if (op === 0 && b.length) b[at % b.length] = int(256);
      else if (op === 1) b.splice(at);
      else if (op === 2) b.splice(at, 0, ...Array.from({ length: 1 + int(8) }, () => int(256)));
      else if (op === 3 && b.length) b.splice(at, 1 + int(4));
      else b.splice(at, 0, ...b.slice(at, at + int(16)));
    }
    out.push(Uint8Array.from(b));
  }
  return out;
}

const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** Run `fn` on each input; collect anything thrown that is not `allowed`. */
function survive(list: Uint8Array[], fn: (b: Uint8Array) => unknown, allowed: (e: unknown) => boolean): string[] {
  const bad: string[] = [];
  for (const b of list) {
    try {
      fn(b);
    } catch (e) {
      if (!allowed(e)) bad.push(`${(e as Error)?.constructor?.name}: ${(e as Error)?.message} on ${Buffer.from(b).toString('hex').slice(0, 80)}`);
    }
  }
  return bad.slice(0, 5);
}

const anyError = (e: unknown) => e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError && !/Invalid typed array length|out of range/i.test(e.message));
const pb = (...parts: number[]) => Uint8Array.from(parts);

describe('parser fuzzing', () => {
  it('protobuf and gRPC decoding fail cleanly', () => {
    const samples = [
      pb(0x08, 0x96, 0x01, 0x12, 0x03, 0x61, 0x62, 0x63, 0x1a, 0x04, 0x08, 0x01, 0x10, 0x02, 0x25, 1, 2, 3, 4, 0x29, 1, 2, 3, 4, 5, 6, 7, 8),
      pb(0x0a, 0x05, 0x0a, 0x03, 0x08, 0x01, 0x10),
    ];
    const grpc = samples.map((s) => Uint8Array.from([0, 0, 0, 0, s.length, ...s]));
    expect(survive(inputs(SEED, samples), decodeProtobuf, anyError)).toEqual([]);
    expect(survive(inputs(SEED + 1, grpc), decodeGrpc, anyError)).toEqual([]);
  });

  it('codec detection never throws', () => {
    const json = Buffer.from('{"user":"alice","token":"eyJhbGciOiJIUzI1NiJ9.e30.x"}');
    const samples = [json, Buffer.from(json.toString('base64')), Buffer.from(encodeURIComponent(json.toString())), gzipSync(json), Buffer.from(gzipSync(json).toString('base64'))];
    expect(survive(inputs(SEED + 2, samples, 600), (b) => detectChain(b), () => false)).toEqual([]);
    expect(survive(inputs(SEED + 3, samples, 600), (b) => detectChain(text(b)), () => false)).toEqual([]);
  });

  it('Socket.IO, SignalR and ViewState decoding fail cleanly', () => {
    const sio = [Buffer.from('42["chat",{"msg":"hi"}]'), Buffer.from('451-/admin,7["upload",{"_placeholder":true,"num":0}]'), Buffer.from('0{"sid":"abc"}')];
    const sr = [Buffer.from('{"type":1,"target":"Send","arguments":["a"]}\x1e{"type":6}\x1e'), Buffer.from('{"protocol":"json","version":1}\x1e')];
    const vs = [Buffer.from('/wEPDwUKLTk1NjQ5ODc1ZGQ=', 'base64'), pb(0xff, 0x01, 0x0f, 0x0f, 0x05, 0x03, 0x61, 0x62, 0x63, 0x64, 0x64)];
    expect(survive(inputs(SEED + 4, sio), (b) => decodeSocketIO(text(b)), anyError)).toEqual([]);
    expect(survive(inputs(SEED + 5, sr), (b) => decodeSignalR(text(b)), anyError)).toEqual([]);
    expect(survive(inputs(SEED + 6, [...sio, ...sr]), (b) => summarizeFrame(text(b)), () => false)).toEqual([]);
    expect(survive(inputs(SEED + 7, vs), decodeViewState, anyError)).toEqual([]);
  });

  it('the MQTT parser throws only MqttError, whole or in pieces', () => {
    const v4 = VECTORS.filter((v) => v.v !== 5).map((v) => Buffer.from(v.hex, 'hex'));
    const v5 = VECTORS.filter((v) => v.v === 5).map((v) => Buffer.from(v.hex, 'hex'));
    const list = inputs(SEED + 8, [...v4, ...v5, Buffer.concat(v4.slice(0, 6))]);
    const r = rng(SEED + 9);
    expect(
      survive(
        list,
        (b) => {
          const p = new MqttParser(r() < 0.3 ? 5 : 4);
          for (let i = 0; i < b.length; ) {
            const n = 1 + Math.floor(r() * 7);
            p.parse(b.subarray(i, i + n));
            i += n;
          }
        },
        (e) => e instanceof MqttError,
      ),
    ).toEqual([]);
  });

  it('the YAML parser throws only YamlError', () => {
    const samples = [
      'openapi: 3.0.0\ninfo:\n  title: Shop\n  version: "1"\npaths:\n  /orders/{id}:\n    get:\n      parameters:\n        - name: id\n          in: path\n          required: true\n      responses:\n        "200": { description: ok }\n',
      'a: &x [1, 2, {b: c}]\nd: *x\ne: |\n  line one\n  line two\nf: >-\n  folded\n  text\ng: !!str 12\n',
      '- one\n- "two\\n"\n- \'three\'\n-\n  - nested\n  - [x, y]\n---\nsecond: doc\n',
    ].map((s) => Buffer.from(s));
    expect(survive(inputs(SEED + 10, samples), (b) => parseYaml(text(b)), (e) => e instanceof YamlError)).toEqual([]);
  });

  it('the QPACK decoder throws only QpackError', async () => {
    const enc = new QpackEncoder(4096, 16, () => undefined);
    const fields = [
      [':method', 'GET'],
      [':path', '/api/orders?page=2'],
      [':authority', 'shop.example'],
      ['cookie', 'session=abc123'],
      ['x-custom', 'value'],
    ] as never;
    const sections = [enc.encode(0, fields), enc.encode(4, fields)];
    const bad: string[] = [];
    for (const b of inputs(SEED + 11, sections, 800)) {
      const dec = new QpackDecoder(0, 0, () => undefined);
      try {
        await dec.decode(0, Buffer.from(b));
      } catch (e) {
        if (!(e instanceof QpackError)) bad.push(`${(e as Error).constructor.name}: ${(e as Error).message} on ${Buffer.from(b).toString('hex')}`);
      }
      try {
        new QpackDecoder(4096, 16, () => undefined).encoderStream(Buffer.from(b));
      } catch (e) {
        if (!(e instanceof QpackError)) bad.push(`encoder stream ${(e as Error).constructor.name}: ${(e as Error).message} on ${Buffer.from(b).toString('hex')}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('keeps the inputs earlier runs found', () => {
    // A ViewState array whose count ran past the end used to allocate until the heap gave out.
    expect(decodeViewState(Buffer.from('ff010f271698c4b831eb5b0f', 'hex')).value).toEqual({ partial: true });
    // A bad \\u escape used to escape as a RangeError.
    expect(() => parseYaml('- "two\\u"\n')).toThrow(YamlError);
  });
});

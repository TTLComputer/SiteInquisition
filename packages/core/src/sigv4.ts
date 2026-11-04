import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HeaderList } from './store.js';

/** AWS Signature Version 4 signing for replays, plus parsing a captured Authorization header. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ParsedSigV4 {
  algorithm: string;
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

export function parseSigV4(authorization: string | undefined): ParsedSigV4 | null {
  if (!authorization) return null;
  const m = /^(AWS4-HMAC-SHA256)\s+Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)/i.exec(authorization.trim());
  if (!m) return null;
  return { algorithm: m[1]!, accessKeyId: m[2]!, date: m[3]!, region: m[4]!, service: m[5]!, signedHeaders: m[6]!.split(';'), signature: m[7]! };
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as AWS wants it (encodeURIComponent leaves !'()* alone). */
const awsEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalQuery(search: string): string {
  const params = [...new URLSearchParams(search)].map(([k, v]) => [awsEncode(k), awsEncode(v)] as const);
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return params.map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalPath(pathname: string, service: string): string {
  // S3 signs the path as sent; other services normalise and double-encode.
  if (service === 's3') return pathname || '/';
  return (
    pathname
      .split('/')
      .map((seg) => awsEncode(decodeURIComponent(seg)))
      .join('/') || '/'
  );
}

const DROP = new Set(['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256', 'connection', 'content-length', 'user-agent', 'expect']);

/**
 * Sign a request. Returns new headers: the originals minus any old signature,
 * plus Host, X-Amz-Date, X-Amz-Content-Sha256, X-Amz-Security-Token and Authorization.
 */
export function signSigV4(
  req: { method: string; url: string; headers: HeaderList; body?: Uint8Array },
  creds: AwsCredentials,
  scope: { region: string; service: string },
  now = new Date(),
): HeaderList {
  const url = new URL(req.url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(req.body ?? new Uint8Array());
  const headers: HeaderList = req.headers.filter(([k]) => !DROP.has(k.toLowerCase()) && !k.startsWith(':'));
  if (!headers.some(([k]) => k.toLowerCase() === 'host')) headers.unshift(['Host', url.host]);
  headers.push(['X-Amz-Date', amzDate], ['X-Amz-Content-Sha256', payloadHash]);
  if (creds.sessionToken) headers.push(['X-Amz-Security-Token', creds.sessionToken]);

  const grouped = new Map<string, string[]>();
  for (const [k, v] of headers) {
    const key = k.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), v.trim().replace(/\s+/g, ' ')]);
  }
  const names = [...grouped.keys()].sort();
  const canonicalHeaders = names.map((n) => `${n}:${grouped.get(n)!.join(',')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [req.method.toUpperCase(), canonicalPath(url.pathname, scope.service), canonicalQuery(url.search), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${date}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, scope.region), scope.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.push(['Authorization', `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`]);
  return headers;
}

/** Read a named profile from the shared credentials file (~/.aws/credentials, or AWS_SHARED_CREDENTIALS_FILE). */
export function loadAwsProfile(profile = 'default'): AwsCredentials {
  if (profile === 'env') {
    const { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: token } = process.env;
    if (!id || !secret) throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set');
    return { accessKeyId: id, secretAccessKey: secret, ...(token ? { sessionToken: token } : {}) };
  }
  const file = process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`cannot read ${file}`);
  }
  let section = '';
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) {
      section = s[1]!.trim();
      continue;
    }
    if (section !== profile) continue;
    const i = line.indexOf('=');
    if (i > 0) values[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if (!values.aws_access_key_id || !values.aws_secret_access_key) throw new Error(`profile "${profile}" not found in ${file}`);
  return { accessKeyId: values.aws_access_key_id, secretAccessKey: values.aws_secret_access_key, ...(values.aws_session_token ? { sessionToken: values.aws_session_token } : {}) };
}

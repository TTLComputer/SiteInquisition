import type { HeaderList } from './store.js';

/**
 * Reading AWS-specific shapes out of a request or URL, so the UI can show
 * them: a SigV4 presigned URL and when it expires, the service operation an
 * X-Amz-Target request calls (otherwise every call looks like a POST to "/"),
 * and the bucket and key of an S3 URL.
 */

export interface PresignInfo {
  accessKeyId: string;
  region: string;
  service: string;
  date: string;
  /** Epoch ms the signature was made. */
  signedAt: number;
  expiresInSeconds: number;
  /** Epoch ms it stops working. */
  expiresAt: number;
  signedHeaders: string[];
}

const amzToMs = (amzDate: string): number | null => {
  // 20261104T193045Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
};

/** Parse a SigV4 presigned URL (query-string signature), or null when it is not one. */
export function parsePresignedUrl(url: string): PresignInfo | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const q = u.searchParams;
  if (q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || !q.get('X-Amz-Signature')) return null;
  const cred = q.get('X-Amz-Credential'); // AKIA.../20261104/us-east-1/s3/aws4_request
  const amzDate = q.get('X-Amz-Date');
  const expires = Number(q.get('X-Amz-Expires'));
  if (!cred || !amzDate || !Number.isFinite(expires)) return null;
  const signedAt = amzToMs(amzDate);
  if (signedAt === null) return null;
  const [accessKeyId, , region, service] = cred.split('/');
  return {
    accessKeyId: accessKeyId ?? '',
    region: region ?? '',
    service: service ?? '',
    date: amzDate.slice(0, 8),
    signedAt,
    expiresInSeconds: expires,
    expiresAt: signedAt + expires * 1000,
    signedHeaders: (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean),
  };
}

export interface AmzTarget {
  /** The full X-Amz-Target, e.g. DynamoDB_20120810.GetItem or AWSCognitoIdentityProviderService.InitiateAuth. */
  target: string;
  /** The service prefix before the dot. */
  service: string;
  /** The operation after the dot, e.g. GetItem. */
  operation: string;
}

/** The AWS JSON-protocol operation a request calls, from its X-Amz-Target header. */
export function parseAmzTarget(headers: HeaderList): AmzTarget | null {
  const t = headers.find(([k]) => k.toLowerCase() === 'x-amz-target')?.[1];
  if (!t) return null;
  const dot = t.lastIndexOf('.');
  return { target: t, service: dot > 0 ? t.slice(0, dot) : '', operation: dot > 0 ? t.slice(dot + 1) : t };
}

export interface S3Ref {
  bucket: string;
  key: string;
  /** How the bucket was addressed. */
  style: 'virtual-host' | 'path' | 'accesspoint' | 'website';
}

/** Bucket and key from an S3 URL, virtual-hosted or path style. */
export function parseS3Url(url: string): S3Ref | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const vhost = /^(.+?)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.exec(host);
  if (vhost) return { bucket: vhost[1]!, key: path, style: 'virtual-host' };
  const website = /^(.+?)\.s3-website[.-][a-z0-9-]+\.amazonaws\.com$/.exec(host);
  if (website) return { bucket: website[1]!, key: path, style: 'website' };
  if (/^s3[.-]?([a-z0-9-]+)?\.amazonaws\.com$/.test(host)) {
    const slash = path.indexOf('/');
    return slash === -1 ? { bucket: path, key: '', style: 'path' } : { bucket: path.slice(0, slash), key: path.slice(slash + 1), style: 'path' };
  }
  return null;
}

export interface AwsRequestInfo {
  presigned?: PresignInfo;
  amzTarget?: AmzTarget;
  s3?: S3Ref;
  apiGateway?: { apiId?: string; stage?: string };
}

/** Everything AWS-shaped about a request, for the Inspector. */
export function awsRequestInfo(req: { url: string; headers: HeaderList }): AwsRequestInfo {
  const out: AwsRequestInfo = {};
  const presigned = parsePresignedUrl(req.url);
  if (presigned) out.presigned = presigned;
  const amzTarget = parseAmzTarget(req.headers);
  if (amzTarget) out.amzTarget = amzTarget;
  const s3 = parseS3Url(req.url);
  if (s3) out.s3 = s3;
  const host = (() => {
    try {
      return new URL(req.url).hostname;
    } catch {
      return '';
    }
  })();
  const gw = /^([a-z0-9]+)\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.exec(host);
  if (gw) {
    const stage = new URL(req.url).pathname.split('/').filter(Boolean)[0];
    out.apiGateway = { apiId: gw[1], ...(stage ? { stage } : {}) };
  }
  return out;
}

/** A short label for an AWS request, for History and coverage: the operation, S3 key, or stage. */
export function awsLabel(info: AwsRequestInfo): string | null {
  if (info.amzTarget) return info.amzTarget.operation;
  if (info.s3) return `s3:${info.s3.bucket}/${info.s3.key || ''}`;
  return null;
}

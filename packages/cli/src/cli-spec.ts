import type { MqttListenerConfig } from '@siteinquisition/core';

/**
 * Parse an MQTT listener spec: LISTEN_PORT=BROKER_HOST[:PORT][,tls][,listen-tls][,insecure]
 *   1883=broker.local              plain in, plain out
 *   8883=broker.example.com:8883,tls,listen-tls
 */
export function parseMqttSpec(spec: string, allowLan: boolean): MqttListenerConfig {
  const m = /^(\d+)=([^,:]+|\[[^\]]+\])(?::(\d+))?((?:,[a-z-]+)*)$/i.exec(spec.trim());
  if (!m) throw new Error(`invalid --mqtt spec "${spec}" (expected PORT=HOST[:PORT][,tls][,listen-tls][,insecure])`);
  const flags = new Set(m[4]!.split(',').filter(Boolean).map((f) => f.toLowerCase()));
  for (const f of flags) if (!['tls', 'listen-tls', 'insecure'].includes(f)) throw new Error(`unknown --mqtt flag "${f}"`);
  return {
    port: Number(m[1]),
    upstreamHost: m[2]!.replace(/^\[|\]$/g, ''),
    upstreamPort: m[3] ? Number(m[3]) : undefined,
    upstreamTls: flags.has('tls'),
    listenTls: flags.has('listen-tls'),
    ignoreUpstreamTlsErrors: flags.has('insecure'),
    allowLan,
  };
}

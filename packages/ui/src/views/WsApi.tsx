import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SiteMapHost, WsEndpoint, WsProtocol } from '../api';
import { useApp } from '../state';
import { fmtTime } from '../format';
import { ReplayButton } from '../components/ReplayButton';

const PROTOCOL: Record<WsProtocol, string> = {
  socketio: 'Socket.IO',
  signalr: 'SignalR',
  'graphql-ws': 'GraphQL over WebSocket',
  'json-rpc': 'JSON-RPC',
  stomp: 'STOMP',
  json: 'JSON messages',
  text: 'Text messages',
  binary: 'Binary messages',
  none: 'No messages yet',
};

/**
 * Explore API > WebSocket APIs: every WebSocket endpoint, the protocol it
 * speaks, and each kind of message sent and received, mapped like the HTTP
 * endpoints are.
 */
export function WsApi() {
  const { client, notify, setQuery, navigate, openStream } = useApp();
  const [hosts, setHosts] = useState<SiteMapHost[]>([]);
  const [host, setHost] = useState('');
  const [list, setList] = useState<WsEndpoint[] | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    setList(null);
    client.wsApi(host || undefined).then(setList, (e: Error) => (notify(e.message), setList([])));
  }, [client, host, notify]);
  useEffect(() => {
    client.siteMap().then(setHosts, () => undefined);
  }, [client]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    if (!list || !f) return list ?? [];
    return list
      .map((ep) => (`${ep.host}${ep.template}`.toLowerCase().includes(f) ? ep : { ...ep, kinds: ep.kinds.filter((k) => `${k.name} ${k.fields.join(' ')}`.toLowerCase().includes(f)) }))
      .filter((ep) => ep.kinds.length || `${ep.host}${ep.template}`.toLowerCase().includes(f));
  }, [list, filter]);

  const connections = (ep: WsEndpoint) => (setQuery(`ws:true host:${ep.host} path:${ep.template.replace(/\{[a-z]+\}.*$/, '')}`), navigate('traffic/requests'));

  return (
    <div className="coverage" aria-label="WebSocket APIs">
      <div className="filterbar">
        <label className="check">
          Host
          <select className="input" aria-label="WebSocket host" value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="">All hosts</option>
            {hosts.map((h) => (
              <option key={h.host} value={h.host}>
                {h.host}
              </option>
            ))}
          </select>
        </label>
        <input className="input" placeholder="Filter by path, message or field" aria-label="Filter WebSocket messages" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: '1 1 200px' }} />
        <button className="btn small" onClick={load}>
          Rescan
        </button>
      </div>
      {!list && <div className="empty">Mapping WebSocket traffic...</div>}
      {list && list.length === 0 && (
        <div className="empty" data-testid="ws-api-empty">
          No WebSocket connections recorded{host ? ` on ${host}` : ''} yet. They appear here once a page or client opens one through the proxy.
        </div>
      )}
      <div className="coverage-body">
        {shown.map((ep) => (
          <section key={`${ep.host} ${ep.template}`} className="ws-endpoint" data-testid="ws-endpoint">
            <div className="ws-endpoint-head">
              <span className="mono m-WS">WS</span>
              <b className="mono">{ep.template}</b>
              <span className="faint">on {ep.host}</span>
              <span className="badge" data-testid="ws-protocol">
                {PROTOCOL[ep.protocol]}
              </span>
              {ep.subprotocols.length > 0 && <span className="faint mono">subprotocol {ep.subprotocols.join(', ')}</span>}
              <span style={{ flex: 1 }} />
              <span className="faint">
                {ep.connections} {ep.connections === 1 ? 'connection' : 'connections'}, {ep.messages} messages, last {fmtTime(ep.lastAt)}
              </span>
              <button className="btn small" onClick={() => connections(ep)} title="Show these connections in Traffic">
                Connections
              </button>
              <ReplayButton id={ep.exampleExchangeId} compact />
            </div>
            {ep.kinds.length === 0 ? (
              <div className="empty-note">No API messages on these connections (only keep-alives, or nothing sent yet).</div>
            ) : (
              <table className="data-table coverage-table" aria-label={`Messages on ${ep.template}`}>
                <thead>
                  <tr>
                    <th>Direction</th>
                    <th>Message</th>
                    <th>Count</th>
                    <th>Fields</th>
                    <th>Example</th>
                  </tr>
                </thead>
                <tbody>
                  {ep.kinds.map((k) => (
                    <tr
                      key={`${k.direction} ${k.name}`}
                      className="clickable-row"
                      tabIndex={0}
                      data-testid="ws-kind"
                      title="Open a connection that carried it in Live connections"
                      onClick={() => openStream(k.exampleExchangeId)}
                      onKeyDown={(e) => e.key === 'Enter' && openStream(k.exampleExchangeId)}
                    >
                      <td className="faint">{k.direction === 'client' ? 'client → server' : 'server → client'}</td>
                      <td className="mono">{k.name}</td>
                      <td className="mono">{k.count}</td>
                      <td className="mono wrap">{k.fields.join(', ')}</td>
                      <td className="mono wrap faint" style={{ maxWidth: 420 }}>
                        {k.example}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

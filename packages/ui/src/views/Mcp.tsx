import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityEntry, Approval, Decision, HeaderList, McpSettings } from '../api';
import { useApp } from '../state';
import { fmtMs, fmtTime } from '../format';

/** What an agent asked to do, and the four ways to answer. */
export function ApprovalCard({ a }: { a: Approval }) {
  const { client, notify, openDraft, openReplayById } = useApp();
  const decide = async (d: Decision) => {
    try {
      await client.decide(a.id, d);
      if (d === 'open-in-replay') {
        if (a.tool === 'replay_request') {
          const args = a.args as { method?: string; url?: string; headers?: HeaderList; body?: string };
          openDraft({ method: String(args.method ?? 'GET'), url: String(args.url ?? ''), headers: args.headers ?? [], body: args.body }, 'from agent');
        } else if (a.tool === 'resend_exchange' && typeof a.args.id === 'string') await openReplayById(a.args.id);
      }
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const canReplay = a.tool === 'replay_request' || a.tool === 'resend_exchange';
  return (
    <div className="card approval" role="group" aria-label={`Agent request: ${a.summary}`}>
      <div className="sec-head">
        <b style={{ color: 'var(--text)' }}>Agent wants to {a.tool.replace(/_/g, ' ')}</b>
        <span className="faint">{fmtTime(a.createdAt)}</span>
      </div>
      <div style={{ padding: '6px 12px' }} className="mono">
        {a.summary}
      </div>
      <details style={{ padding: '0 12px 6px' }}>
        <summary className="faint" style={{ fontSize: 12 }}>
          Arguments
        </summary>
        <pre className="raw" style={{ maxHeight: 200, overflow: 'auto' }}>
          {JSON.stringify(a.args, null, 2)}
        </pre>
      </details>
      <div className="replay-bar" style={{ borderBottom: 'none' }}>
        <button className="btn small primary" onClick={() => void decide('once')}>
          Approve once
        </button>
        <button className="btn small" onClick={() => void decide('ten-minutes')} title={`Approve every ${a.tool} call for the next 10 minutes`}>
          Approve for 10 minutes
        </button>
        {canReplay && (
          <button className="btn small" onClick={() => void decide('open-in-replay')} title="Do not send; open it in a Replay tab so you can check and send it yourself">
            Open in Replay instead
          </button>
        )}
        <button className="btn small" onClick={() => void decide('deny')}>
          Deny
        </button>
      </div>
    </div>
  );
}

/** Title bar chip: pending agent approvals, answered in place. */
export function ApprovalChip() {
  const { approvals } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!approvals.length) setOpen(false);
  }, [approvals.length]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!approvals.length) return null;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="chip-btn attention" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="approval-chip">
        <span className="dot" style={{ background: 'var(--warn)' }} />
        {approvals.length === 1 ? 'Agent is waiting for approval' : `${approvals.length} agent requests waiting`}
      </button>
      {open && (
        <div className="approval-pop">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function Copy({ text }: { text: string }) {
  const { notify } = useApp();
  return (
    <span className="copy-line">
      <code className="mono">{text}</code>
      <button className="btn small" onClick={() => navigator.clipboard.writeText(text).then(() => notify('Copied'), () => notify('Could not copy'))}>
        Copy
      </button>
    </span>
  );
}

export function McpSection({ Row }: { Row: (p: { label: string; children: React.ReactNode }) => JSX.Element }) {
  const { client, info, approvals, notify } = useApp();
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const load = useCallback(() => {
    client.mcpSettings().then(setSettings, () => undefined);
    client.mcpActivity().then(setActivity, () => undefined);
  }, [client]);
  useEffect(() => {
    load();
    const off = client.onChange((c) => (c.kind === 'mcp.activity' || (c.kind === 'meta.set' && c.entityId === 'mcpSettings')) && load());
    return () => {
      off();
    };
  }, [client, load]);
  const http = info?.apiPort ? `http://127.0.0.1:${info.apiPort}/mcp` : null;
  const dir = info?.projectDir ?? '.';
  return (
    <>
      <div className="panel-title" style={{ padding: '12px 14px' }}>
        MCP and agents
      </div>
      <Row label="Write actions">
        <div className="segmented" role="group" aria-label="Agent write actions">
          <button className="seg" aria-pressed={settings?.writeMode !== 'allow'} onClick={() => client.setMcpSettings({ writeMode: 'ask' }).then(setSettings, (e: Error) => notify(e.message))}>
            Ask each time
          </button>
          <button
            className="seg"
            aria-pressed={settings?.writeMode === 'allow'}
            onClick={() => {
              if (window.confirm('Let agents send traffic and change settings without asking?')) client.setMcpSettings({ writeMode: 'allow' }).then(setSettings, (e: Error) => notify(e.message));
            }}
          >
            Allow without asking
          </button>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
          Reading traffic never asks. Sending requests, tagging, changing scope and running scripts ask unless this is set to allow.
        </div>
      </Row>
      <Row label="Claude Code (stdio)">
        <Copy text={`claude mcp add siteinquisition -- siq mcp --project ${JSON.stringify(dir)}`} />
        <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
          Starts a small bridge that finds this running app through the project folder, so it keeps working when the port or token change.
        </div>
      </Row>
      {http && (
        <Row label="HTTP">
          <Copy text={http} />
          <div className="faint" style={{ fontSize: 12, margin: '4px 0' }}>
            Send the token as <span className="mono">Authorization: Bearer …</span>. It changes when the app restarts.
          </div>
          <Copy text={`claude mcp add --transport http siteinquisition ${http} --header "Authorization: Bearer ${client.conn.token}"`} />
        </Row>
      )}
      {approvals.length > 0 && (
        <Row label="Waiting">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} a={a} />
          ))}
        </Row>
      )}
      <Row label="Activity">
        {activity.length === 0 ? (
          <span className="faint">No agent calls yet.</span>
        ) : (
          <table className="data-table">
            <tbody>
              {[...activity].reverse().slice(0, 100).map((a, i) => (
                <tr key={i}>
                  <td className="faint">{fmtTime(a.at)}</td>
                  <td className="mono">{a.tool}</td>
                  <td>{a.summary}</td>
                  <td className={a.outcome === 'ok' ? 's-2' : a.outcome === 'error' ? 's-5' : 's-4'}>{a.outcome}</td>
                  <td className="mono faint">{fmtMs(a.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Row>
    </>
  );
}

import { EventEmitter } from 'node:events';
import { newId } from './ids.js';
import { VERSION } from './version.js';

/**
 * The MCP server: tools an agent can call, and the approval queue for the
 * ones that change something or send traffic. Transports (stdio via `siq mcp`,
 * or HTTP on the core API port) hand JSON-RPC messages to `handle`.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Writes need approval unless the project allows them. */
  write: boolean;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
  /** One line for the approval card. */
  summary?(args: Record<string, unknown>): string;
}

export interface McpSettings {
  /** "ask": every write waits for approval in the UI. "allow": writes run straight away. */
  writeMode: 'ask' | 'allow';
}

export interface Approval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  createdAt: number;
}

export type Decision = 'once' | 'ten-minutes' | 'deny' | 'open-in-replay';

export interface ActivityEntry {
  at: number;
  tool: string;
  summary: string;
  outcome: 'ok' | 'error' | 'denied' | 'timed out' | 'sent to replay';
  ms: number;
}

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const PROTOCOL = '2025-06-18';

export class McpServer extends EventEmitter<{ approval: [Approval]; decided: [string, Decision]; activity: [ActivityEntry] }> {
  private pending = new Map<string, { approval: Approval; resolve: (d: Decision) => void; timer: NodeJS.Timeout }>();
  private grants = new Map<string, number>();
  readonly activity: ActivityEntry[] = [];

  constructor(
    private readonly tools: ToolDef[],
    private readonly settings: () => McpSettings,
  ) {
    super();
  }

  approvals(): Approval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  decide(id: string, decision: Decision): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (decision === 'ten-minutes') this.grants.set(p.approval.tool, Date.now() + 10 * 60_000);
    p.resolve(decision);
    this.emit('decided', id, decision);
    return true;
  }

  private log(e: ActivityEntry) {
    this.activity.push(e);
    if (this.activity.length > 500) this.activity.splice(0, this.activity.length - 500);
    this.emit('activity', e);
  }

  private async approve(tool: ToolDef, args: Record<string, unknown>): Promise<Decision> {
    if (this.settings().writeMode === 'allow') return 'once';
    const grant = this.grants.get(tool.name);
    if (grant && grant > Date.now()) return 'once';
    const approval: Approval = { id: newId(), tool: tool.name, args, summary: tool.summary?.(args) ?? tool.name, createdAt: Date.now() };
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approval.id);
        resolve('deny');
        this.emit('decided', approval.id, 'deny');
      }, APPROVAL_TIMEOUT_MS);
      this.pending.set(approval.id, { approval, resolve, timer });
      this.emit('approval', approval);
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
    const t0 = Date.now();
    const summary = tool.summary?.(args) ?? name;
    if (tool.write) {
      const d = await this.approve(tool, args);
      if (d === 'deny' || d === 'open-in-replay') {
        const sent = d === 'open-in-replay';
        this.log({ at: t0, tool: name, summary, outcome: sent ? 'sent to replay' : 'denied', ms: Date.now() - t0 });
        return {
          content: [{ type: 'text', text: sent ? 'The user opened this request in a replay tab to review it instead of running it.' : 'The user did not approve this action.' }],
          isError: true,
        };
      }
    }
    try {
      const result = await tool.run(args);
      this.log({ at: t0, tool: name, summary, outcome: 'ok', ms: Date.now() - t0 });
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
    } catch (e) {
      this.log({ at: t0, tool: name, summary, outcome: 'error', ms: Date.now() - t0 });
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  }

  /** Handle one JSON-RPC message; returns the response, or undefined for notifications. */
  async handle(msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }): Promise<Record<string, unknown> | undefined> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined || msg.id === null) return undefined; // notifications such as notifications/initialized
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'siteinquisition', version: VERSION },
          instructions:
            'SiteInquisition records HTTP, WebSocket and MQTT traffic for the app under test. Use search_traffic with the search syntax (host:, method:, status:>=400, path:, "free text", since:) to find exchanges, get_exchange to read one, and replay_request to send an edited copy. Tools that send traffic or change settings wait for the user to approve them.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.write ? `${t.description} Needs the user's approval unless the project allows agent writes.` : t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: !t.write },
          })),
        });
      case 'tools/call': {
        const name = msg.params?.name;
        if (typeof name !== 'string') return fail(-32602, 'tools/call needs a tool name');
        return reply(await this.call(name, (msg.params?.arguments as Record<string, unknown>) ?? {}));
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }
}

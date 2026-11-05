import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@siteinquisition/devkit/test';
import { Core } from '@siteinquisition/core';

/**
 * Every MCP tool that sends traffic, runs code or changes the project must
 * be labelled a write, so "ask" mode stops it for approval. A new tool has to
 * be added to one of these lists on purpose.
 */
const WRITES = ['run_flow', 'auth_matrix', 'negative_tests', 'run_tech_check', 'replay_request', 'resend_exchange', 'tag_exchange', 'set_notes', 'add_scope_host', 'run_script', 'replay_websocket'];
const READS = [
  'search_traffic', 'get_exchange', 'site_map', 'endpoint_coverage', 'api_values', 'value_origin', 'tag_value', 'api_specs', 'list_flows', 'contract_check',
  'resource_lifecycle', 'field_glossary', 'diff_exchanges', 'endpoint_notes', 'graphql_operations', 'copy_as_curl', 'decode', 'list_cookies',
  'detect_technologies', 'find_errors', 'decode_jwt', 'decode_session_cookie', 'aws_request_info', 'csrf_tokens', 'get_scope', 'parse_sigv4', 'websocket_script',
];

let dir: string;
let core: Core;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'siq-mcp-labels-'));
  core = await Core.open({ projectDir: join(dir, 'p'), dataDir: join(dir, 'd'), api: false });
});
afterAll(async () => {
  await core.close();
  rmSync(dir, { recursive: true, force: true });
});

const listed = async () => {
  const r = (await core.tools.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
  return r.result.tools;
};

describe('MCP write labels', () => {
  it('labels exactly the known write tools as writes, and tells clients', async () => {
    const tools = await listed();
    expect(tools.map((t) => t.name).sort()).toEqual([...WRITES, ...READS].sort());
    for (const t of tools) expect([t.name, t.annotations.readOnlyHint]).toEqual([t.name, READS.includes(t.name)]);
  });

  it('stops every write tool for approval in ask mode, and lets reads straight through', async () => {
    core.tools.setMcpSettings({ writeMode: 'ask' });
    for (const name of WRITES) {
      const before = core.tools.mcp.approvals().length;
      const call = core.tools.mcp.call(name, {});
      for (let i = 0; i < 50 && core.tools.mcp.approvals().length === before; i++) await new Promise((r) => setTimeout(r, 5));
      const pending = core.tools.mcp.approvals();
      expect([name, pending.length]).toEqual([name, before + 1]);
      core.tools.mcp.decide(pending.at(-1)!.id, 'deny');
      const r = await call;
      expect([name, r.isError]).toEqual([name, true]);
    }
    for (const name of READS) {
      await core.tools.mcp.call(name, {});
      expect([name, core.tools.mcp.approvals().length]).toEqual([name, 0]);
    }
  });
});

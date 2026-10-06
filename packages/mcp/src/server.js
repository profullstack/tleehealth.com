/**
 * tleehealth over MCP: newline-delimited JSON-RPC 2.0 on stdio.
 * Auth is TLEEHEALTH_API_KEY; TLEEHEALTH_URL points it at another server.
 */
import { createInterface } from 'node:readline';
import { health, resolveAuth, schedule } from '@profullstack/tleehealth/client';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'get_schedule',
    description:
      "The practice's appointments for one day across every location: time, patient, provider, location or video, reason and status. Needs TLEEHEALTH_API_KEY (create one in the app under Settings).",
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'today (default), tomorrow or YYYY-MM-DD' } },
      additionalProperties: false,
    },
  },
  {
    name: 'api_health',
    description: 'Whether the tleehealth API is up, and its version.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const textResult = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function callTool(name, args) {
  const auth = await resolveAuth();
  switch (name) {
    case 'get_schedule':
      return textResult(await schedule(auth, args.date));
    case 'api_health':
      return textResult(await health(auth));
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function handle(req) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'tleehealth', version: '0.1.0' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return await callTool(req.params?.name, req.params?.arguments ?? {});
      } catch (err) {
        return textResult(String(err?.message ?? err), true);
      }
    case 'ping':
      return {};
    default:
      throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
  }
}

export function serve(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    if (req.id === undefined) return;
    try {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: await handle(req) })}\n`);
    } catch (err) {
      output.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: err.code ?? -32603, message: String(err.message) } })}\n`,
      );
    }
  });
  return rl;
}

export { handle, TOOLS };

/**
 * tleehealth over MCP: newline-delimited JSON-RPC 2.0 on stdio.
 * Auth is TLEEHEALTH_API_KEY; TLEEHEALTH_URL points it at another server.
 */
import { createInterface } from 'node:readline';
import { caseload, health, logTime, resolveAuth, schedule, superbill } from '@profullstack/tleehealth/client';

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
    name: 'get_caseload',
    description:
      "Patients enrolled in care-management programs (PIN, PIN peer support, CHI, CCM), with the month's logged minutes, the billing codes earned so far (G0023/G0024, G0140/G0146, G0019/G0022, 99490/99439), minutes to the next unit, open care-plan tasks and anything blocking a claim. An advocate sees their own patients unless all is true.",
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM; default this month' },
        all: { type: 'boolean', description: "everyone's patients, not only the caller's" },
        org: { type: 'string', description: 'practice id; default the first practice' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_superbill',
    description:
      "The month's billable care-management codes per patient: program, condition, billing practitioner and NPI, minutes, codes and units, and ready / on hold (with the reason) / under threshold. Owners, org managers and providers only. A code counts only when its full time is met (60 minutes for G0023, 30 per add-on, 20 for CCM).",
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM; default this month' },
        csv: { type: 'boolean', description: 'return the CSV for a biller instead of JSON' },
        org: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'log_navigation_time',
    description:
      "Log minutes of navigation work by the caller against a patient's program enrollment (program_id from get_caseload). Returns the month's new total and codes. Log each minute once, against one program.",
    inputSchema: {
      type: 'object',
      properties: {
        program_id: { type: 'string' },
        minutes: { type: 'integer', minimum: 1, maximum: 240 },
        activity: {
          type: 'string',
          enum: ['assessment', 'care_plan', 'coordination', 'referral', 'prior_auth', 'scheduling', 'education', 'community_resources', 'call', 'other'],
        },
        note: { type: 'string', description: 'what was done' },
        date: { type: 'string', description: 'YYYY-MM-DD; default today' },
        org: { type: 'string' },
      },
      required: ['program_id', 'minutes'],
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
    case 'get_caseload':
      return textResult(await caseload(auth, args));
    case 'get_superbill':
      return textResult(await superbill(auth, args));
    case 'log_navigation_time':
      return textResult(await logTime(auth, { ...args, program: args.program_id }));
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

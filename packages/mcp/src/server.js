/**
 * tleehealth over MCP: newline-delimited JSON-RPC 2.0 on stdio.
 * Auth is TLEEHEALTH_API_KEY; TLEEHEALTH_URL points it at another server.
 */
import { createInterface } from 'node:readline';
import {
  caseload, connect, dashboardDay, health, logTime, providers, recordItem, recordItems, records, resolveAuth, schedule, superbill,
  syncConnection,
} from '@profullstack/tleehealth/client';

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
    name: 'get_dashboard',
    description:
      "The practice dashboard for a day: every appointment with its AI reminder/follow-up call state, plus everything waiting on a human (flagged calls, refill requests, lab results to release, visit summaries to sign).",
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'today (default), tomorrow or YYYY-MM-DD' }, org: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_health_records',
    description:
      "The caller's own health records imported from other providers (MyChart and any SMART on FHIR patient portal): connected providers and their sync state, personal information (name, birth date, phones, emails, addresses, MRNs and other identifiers), and how many records are in each category.",
    inputSchema: { type: 'object', properties: { connection: { type: 'string', description: 'one connection id' } }, additionalProperties: false },
  },
  {
    name: 'list_health_records',
    description:
      'Imported records in one category, newest first, each with date, title, a one-line detail (a lab value, a medication dose) and its attached files. Use get_health_record for the full FHIR resource.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['profile', 'visits', 'summaries', 'notes', 'labs', 'imaging', 'reports', 'medications', 'conditions', 'allergies', 'immunizations', 'procedures', 'vitals', 'observations', 'care_plans', 'insurance', 'other'],
        },
        q: { type: 'string', description: 'words in the title' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_health_record',
    description: 'One imported record in full: the FHIR resource as the provider sent it, and its attached files.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'find_health_providers',
    description: 'Search providers the caller can connect to import records: every Epic/MyChart organization, plus a demo sandbox.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'words in the organization name' } }, additionalProperties: false },
  },
  {
    name: 'connect_health_provider',
    description:
      "Start connecting a provider (provider_id from find_health_providers, or fhir_base for any SMART on FHIR server). Returns authorize_url: the PERSON must open it and sign in at their provider; the import then runs by itself. Check progress with get_health_records.",
    inputSchema: {
      type: 'object',
      properties: { provider_id: { type: 'string' }, fhir_base: { type: 'string' }, name: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'sync_health_records',
    description: 'Import again from one connected provider (or all when connection is omitted) and wait for it to finish.',
    inputSchema: { type: 'object', properties: { connection: { type: 'string' } }, additionalProperties: false },
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
    case 'get_dashboard':
      return textResult(await dashboardDay(auth, args));
    case 'get_health_records':
      return textResult(await records(auth, args));
    case 'list_health_records':
      return textResult(await recordItems(auth, args));
    case 'get_health_record':
      return textResult(await recordItem(auth, args.id));
    case 'find_health_providers':
      return textResult(await providers(auth, args.q ?? ''));
    case 'connect_health_provider':
      return textResult(await connect(auth, { provider: args.provider_id, fhirBase: args.fhir_base, name: args.name }));
    case 'sync_health_records': {
      const ids = args.connection
        ? [args.connection]
        : (await records(auth)).connections.filter((c) => ['active', 'error'].includes(c.status)).map((c) => c.id);
      const out = [];
      for (const id of ids) out.push({ connection: id, ...(await syncConnection(auth, id, { wait: true })) });
      return textResult(out);
    }
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

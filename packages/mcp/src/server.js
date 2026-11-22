/**
 * tleehealth over MCP: newline-delimited JSON-RPC 2.0 on stdio.
 * Auth is TLEEHEALTH_API_KEY; TLEEHEALTH_URL points it at another server.
 */
import { createInterface } from 'node:readline';
import {
  call, resolveOrg,
  caseload, connect, dashboardDay, health, logTime, providers, recordItem, recordItems, records, resolveAuth, schedule, superbill,
  recordVaultObjects, recordVaultStatus, syncConnection,
  providerByNpi, providerDirectory, readingShares, revokeReadingShare,
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
    name: 'ask_records',
    description:
      "Ask a question about imported health records and get an answer written only from those records, with citations ([R1]...) to the records used. Paid from the caller's own c0mpute.com balance (they connect c0mpute once in the web app at /portal/records; an empty balance returns balance_required with a top-up link). The question and the selected record excerpts are processed on a Profullstack-operated node through c0mpute's private house lane, never the open network; tleehealth stores no transcript. With patient_id, a practice user asks about records that patient shared with the practice. Can take a minute or two. Not medical advice: never use it to diagnose or change treatment.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'the question, under 1000 characters' },
        patient_id: { type: 'string', description: 'practice users: the patient (org person id) whose shared records to ask about' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_c0mpute_status',
    description: "The caller's c0mpute connection for Ask AI: connected, status (active, locked, invalid or none), account name, spendable balance and the top-up link. Never returns the key.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_encrypted_vault_status',
    description: 'Return only whether the caller has a device-encrypted personal record vault and its encrypted byte/file counts. Never returns the wrapped key, filenames, index, or medical contents; MCP cannot unlock this vault.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_encrypted_vault_objects',
    description: 'List opaque ciphertext object IDs, sizes and upload times for the caller’s encrypted personal record vault. No filenames, decrypted metadata or medical contents are available through MCP.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
  },
  {
    name: 'search_provider_directory',
    description:
      'Find a US doctor, clinician, hospital, pharmacy or clinic in the public NPI registry by name, specialty and location. Give npi alone to read one record. Needs at least a name, specialty, city or zip.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: "a person's name (\"jane smith\" or \"smith\") or an organization name" },
        specialty: { type: 'string', description: 'a specialty id such as cardiology, family-medicine, pediatrics, pharmacy, hospital' },
        city: { type: 'string' },
        state: { type: 'string', description: 'two-letter US state' },
        zip: { type: 'string', description: 'five-digit ZIP code' },
        type: { type: 'string', enum: ['individual', 'organization'] },
        page: { type: 'integer', minimum: 1 },
        npi: { type: 'string', description: 'a 10-digit NPI to look up directly' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_reading_shares',
    description:
      "The caller's active health tracker shares: opaque ids, created and expiry dates and how many times each was opened. Shares are encrypted under a passkey this server never sees, so readings and labels are not available here.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'revoke_reading_share',
    description: 'Revoke one health tracker share by id: the link stops working and the encrypted copy is deleted. Confirm with the user first.',
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
      "Automatic provider connections are paused; this tool currently returns HTTP 410. The patient can download records from their provider portal and import files in the tleehealth web app at /portal/records.",
    inputSchema: {
      type: 'object',
      properties: { provider_id: { type: 'string' }, fhir_base: { type: 'string' }, name: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'sync_health_records',
    description: 'Sync an older SMART connection if one exists. Manual file uploads cannot sync; automatic provider connections are paused.',
    inputSchema: { type: 'object', properties: { connection: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'redeem_credit_code',
    description:
      "Redeem a tleehealth credit code (CR-XXXX-XXXX-XXXX-XXXX) for days of a practice's paid plan. With org (or by default your first practice you administer) the days go onto that practice; keep=true puts them in your balance.",
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, org: { type: 'string', description: 'practice id' }, keep: { type: 'boolean' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_credits',
    description: "Your balance of pro_days (days of a practice's paid plan from codes and invites) and its history.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_invite',
    description: 'Make an invite link (3 per account). When someone new signs up with it you both get days of the paid plan. The link is shown once.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false },
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
    case 'ask_records': {
      try {
        return textResult(await call(auth, '/api/v1/records/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args.patient_id ? { question: args.question, patient_id: args.patient_id } : { question: args.question }),
        }));
      } catch (err) {
        // The reason (balance_required, c0mpute_locked, house_lane_unavailable, ...) tells the agent what the person must do.
        return textResult({ error: err.body?.error ?? err.message, reason: err.body?.reason ?? null, top_up: err.body?.top_up ?? null }, true);
      }
    }
    case 'get_c0mpute_status':
      return textResult(await call(auth, '/api/v1/c0mpute'));
    case 'get_encrypted_vault_status': {
      const status = await recordVaultStatus(auth);
      const { configured, objects, bytes, max_file_bytes, max_object_bytes, max_vault_bytes } = status;
      return textResult({ configured, objects, bytes, max_file_bytes, max_object_bytes, max_vault_bytes });
    }
    case 'list_encrypted_vault_objects':
      return textResult(await recordVaultObjects(auth, args));
    case 'search_provider_directory': {
      if (args.npi) return textResult(await providerByNpi(auth, args.npi));
      return textResult(await providerDirectory(auth, args));
    }
    case 'list_reading_shares': {
      const { shares } = await readingShares(auth);
      return textResult(shares.map(({ id, created_at, expires_at, views, last_viewed_at }) => ({ id, created_at, expires_at, views, last_viewed_at })));
    }
    case 'revoke_reading_share':
      return textResult(await revokeReadingShare(auth, args.id));
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
    case 'redeem_credit_code': {
      const org = args.keep ? undefined : await resolveOrg(auth, args.org).catch(() => undefined);
      return textResult(await call(auth, '/api/v1/credits/redeem', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: args.code, ...(org ? { org_id: org } : {}) }),
      }));
    }
    case 'get_credits':
      return textResult(await call(auth, '/api/v1/credits'));
    case 'create_invite':
      return textResult(await call(auth, '/api/v1/invites', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: args.note }),
      }));
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

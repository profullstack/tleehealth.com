# @profullstack/tleehealth-mcp

MCP server for [tleehealth](https://tleehealth.pwa.pit.world).

```json
{ "mcpServers": { "tleehealth": { "command": "npx", "args": ["-y", "@profullstack/tleehealth-mcp"] } } }
```

Tools include the practice schedule and dashboard, care-management caseload and
superbill, navigation time, credits/invites, and imported health records. Health
record tools return PHI through the API key's account permissions. Automatic provider
connections are paused; `connect_health_provider` currently returns HTTP 410.

Set `TLEEHEALTH_API_KEY` from Settings in the web app.

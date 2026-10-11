#!/usr/bin/env bash
# Creates the Cloudflare Access application that sits IN FRONT of the Worker.
# Requires: curl, node (already needed for this project).
#
#   export CLOUDFLARE_ACCOUNT_ID=...      # dash.cloudflare.com -> any zone -> Overview sidebar
#   export CLOUDFLARE_API_TOKEN=...       # custom token, permission: Account > Access: Apps and Policies > Edit
#   export MCP_HOST=github-mcp.example.com
#   export ALLOWED_EMAIL=you@example.com  # the ONLY person allowed in
#   ./scripts/create-access-app.sh
#
# Delete the API token afterwards; you don't need it to run the server.
set -euo pipefail
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${MCP_HOST:?set MCP_HOST}"
: "${ALLOWED_EMAIL:?set ALLOWED_EMAIL}"

resp=$(curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data @- <<JSON
{
  "type": "self_hosted",
  "name": "github-mcp-secure",
  "domain": "${MCP_HOST}",
  "destinations": [{ "type": "public", "uri": "${MCP_HOST}" }],
  "app_launcher_visible": false,
  "session_duration": "24h",
  "policies": [{
    "name": "Only me",
    "decision": "allow",
    "include": [{ "email": { "email": "${ALLOWED_EMAIL}" } }]
  }],
  "oauth_configuration": {
    "enabled": true,
    "grant": { "session_duration": "168h", "access_token_lifetime": "15m" },
    "dynamic_client_registration": {
      "enabled": true,
      "allow_any_on_localhost": false,
      "allow_any_on_loopback": false,
      "allowed_uris": [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback"
      ]
    }
  }
}
JSON
)

printf '%s' "$resp" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  if(!j.success){console.error("FAILED:",JSON.stringify(j.errors,null,2));process.exit(1)}
  console.log("Access app created.\n");
  console.log("  ACCESS_AUD =", j.result.aud);
  console.log("\nPut that value in wrangler.jsonc (vars.ACCESS_AUD).");
})'

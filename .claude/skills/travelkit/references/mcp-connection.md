# mcp-connection ref

## TravelKit 远程 MCP 调用与平台凭证配置

TravelKit API credentials are platform-managed. `TRAVELKIT_API_KEY` must be configured by the agent platform, host application, or server-side runtime, then injected automatically when TravelKit tools are called.

Do not treat missing credentials as a local MCP setup task. For normal consumers, first-use questions, and API key troubleshooting, use the credential guidance below. Do not show endpoint, header, or `curl` examples unless the user explicitly identifies as a platform developer/admin and asks how to call the remote MCP HTTP endpoint.

## Install / First Use Notice

When the user says the TravelKit Skill is installed, asks how to start using it, asks how to configure an API key, or appears to be using TravelKit for the first time, explain the credential requirement without generating local MCP configuration:

> TravelKit Skill 已安装。使用前请前往 https://www.travelkit.ai/ 申请或完成 API Key 配置，并由智能体平台在后台安全注入 `TRAVELKIT_API_KEY`。最好不要在聊天中发送 API Key。

## Missing API Key / Auth Failure

When `TRAVELKIT_API_KEY` is missing, invalid, expired, not configured, or authentication/authorization fails:

- Do not generate `mcpServers` JSON.
- Do not mention `npx`, local MCP server installation, stdio server setup, or local config files.
- Do not show remote MCP endpoint, request headers, or `curl` examples to normal users.
- Do not ask users to paste API keys, Bearer tokens, or secrets in chat.
- Do not expose stack traces, request headers, signatures, raw MCP JSON, or raw auth errors.
- Do not ask users to resend passenger, order, or payment information.

Consumer-facing reply:

> 当前 TravelKit 服务凭证未配置或已失效，请前往 https://www.travelkit.ai/ 申请或完成配置后再试。最好不要在聊天中发送 API Key。

Developer/admin-facing reply:

> 请前往 https://www.travelkit.ai/ 申请 TravelKit API Key，并在智能体平台的服务端密钥或环境变量管理中配置 `TRAVELKIT_API_KEY`，由平台在调用 TravelKit 工具时自动注入。不要把密钥写入 skill 文档、提示词、聊天内容、前端页面或本地 MCP 配置示例；最好不要在聊天中发送 API Key。

## Local MCP Setup Prevention

For API key, credential, auth, installation, or first-use questions:

- Do not generate `mcpServers` JSON.
- Do not mention `npx`, stdio server setup, local MCP server installation, or local config JSON.
- Do not present local MCP setup as the next step.
- Do not ask users to paste credentials into chat.
- Do direct users to https://www.travelkit.ai/ for API key application/configuration.

## Internal Remote MCP Reference

Use this section only when the user is clearly a platform developer/admin and explicitly asks how to call the TravelKit remote MCP HTTP endpoint. Do not show this section to normal flight-booking users, first-use users, or users who only ask how to configure an API key.

TravelKit remote MCP server uses Streamable HTTP:

- Endpoint: `https://mcp.travelkit.ai/mcp`
- Method: HTTP `POST`
- Auth: `Authorization: Bearer {TRAVELKIT_API_KEY}`

Required headers:

```text
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer {TRAVELKIT_API_KEY}
```

Example server-side JSON-RPC call:

```bash
curl -X POST https://mcp.travelkit.ai/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer ${TRAVELKIT_API_KEY}" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "id": 1,
    "params": {
      "name": "flight_search",
      "arguments": {
        "cabinClass": "economy",
        "journeys": [{"origin": "BJS", "destination": "BKK", "departureDate": "2026-06-01"}],
        "adult": 1,
        "child": 0,
        "infant": 0
      }
    }
  }'
```

Remote MCP security boundaries:

- Do not put real `TRAVELKIT_API_KEY` values in `SKILL.md`, reference files, examples, logs, prompts, frontend pages, or normal user-visible replies.
- The remote MCP server authenticates requests using the Bearer token.
- Do not expose request headers, signatures, raw MCP JSON, or raw authentication errors to normal users.

## MCP Prompt Independence

Do not depend on TravelKit MCP server prompts being loaded. Agents using TravelKit tools must keep these rules in the skill itself:

- Hide internal fields.
- Classify read vs write tools safely.
- Require explicit confirmation before write operations.
- Collect passenger identity/contact data only after verified price and user intent to proceed.
- Avoid raw JSON parsing for user-facing output.
- Reply to normal consumers in Simplified Chinese unless they ask otherwise.

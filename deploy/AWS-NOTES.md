# Imali AI on Amazon Bedrock AgentCore Runtime

AWS account 247794289304, region us-east-1. Everything below is made by `deploy/agentcore.sh`, except the runtime's IAM
role, which an administrator makes once.

- **Shop books runtime** `imali_ai_alexa_mcp` (id `imali_ai_alexa_mcp-HMEl7f6r8r`): the books MCP server. MCP URL:
  `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A247794289304%3Aruntime%2Fimali_ai_alexa_mcp-HMEl7f6r8r/invocations?qualifier=DEFAULT`.
  Its environment holds `SUPPLIER_MCP_URL`, the supplier runtime's URL.
- **Supplier network runtime** `imali_ai_alexa_supplier`: the same image started with `IMALI_ROLE=supplier`, serving the
  supplier network's MCP server. The books runtime calls it over MCP, forwarding the caller's token.
- **Both runtimes:** protocol MCP, public network, stateful sessions, role `ImaliAiAlexaAgentCoreRole`, image from ECR
  repository `imali-ai-alexa-mcp`, idle sessions end after 300 s and a microVM lives at most 3,600 s.
- **Sign-in:** Cognito pool `imali-ai-alexa-owners` (`us-east-1_p4njRKCgB`), app client `1i6tbosvleocks39oakfjfrgeq`
  (USER_PASSWORD_AUTH, 60-minute tokens), users `judge` and `rudo-demo`. Passwords are not in this repository. A request
  without a token gets 401. On AgentCore the shop is `<signed-in user>-<shop header>`, so a caller reaches only their
  own shops.
- **Books:** DynamoDB table `imali-ai-alexa-books`, on demand: one item per shop, and one per shop's supplier orders.
- **Hosted page:** https://imali-ai-alexa-plus.vercel.app (`scripts/deploy-vercel.sh`). Its model relay checks the
  caller's Cognito token (signature, issuer, app client, expiry) before relaying to the agent model.

## Redeploy

Commit, then run `deploy/agentcore.sh` from the repository root. It builds one ARM64 image from a clean copy of HEAD
(uncommitted changes are not shipped), updates both runtimes, waits for READY and writes the ids to
`deploy/agentcore.out.json`. `scripts/smoke.mjs` checks it end to end. Then `scripts/deploy-vercel.sh` for the page.

## Measured on 23 October 2026, from a workstation in Korea

Milliseconds per step of `scripts/smoke.mjs`, on warm runtimes after the supplier runtime was added. Each call includes
the round trip to Virginia. `reorder_stock` covers the books server's quote from the supplier runtime, the elicitation
answered by the script, and the order placed with the supplier.

| Step | Run 1 | Run 2 |
| --- | --- | --- |
| initialize | 2256 | 2232 |
| tools/list | 1196 | 1325 |
| record_sale | 602 | 614 |
| record_sale on credit | 491 | 496 |
| reorder_stock across both runtimes | 3456 | 3470 |
| second session: initialize | 1294 | 1230 |
| get_customer_tabs | 966 | 1010 |
| close_day | 457 | 461 |
| read the journal resource | 482 | 463 |

Right after a redeploy, `initialize` took about 7 s (cold microVMs), and the first reorder of a session took 8.8 s
while the supplier runtime was also cold.

## Cost controls

Idle sessions end after 300 s, and a microVM lives at most 3,600 s. The table is on demand. ECR keeps the last 5
images. The hosted page's model relay answers only signed-in callers, at most 30 requests a minute per user, and its
model key has its own monthly budget.

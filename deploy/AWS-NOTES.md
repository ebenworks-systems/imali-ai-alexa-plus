# Imali AI on Amazon Bedrock AgentCore Runtime

AWS account 247794289304, region us-east-1.

- Runtime `imali_ai_alexa_mcp` (id `imali_ai_alexa_mcp-HMEl7f6r8r`): protocol MCP, public network, role `ImaliAiAlexaAgentCoreRole`, image from ECR repository `imali-ai-alexa-mcp`. MCP URL: `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A247794289304%3Aruntime%2Fimali_ai_alexa_mcp-HMEl7f6r8r/invocations?qualifier=DEFAULT`
- Sign-in: Cognito pool `imali-ai-alexa-owners` (`us-east-1_p4njRKCgB`), app client `1i6tbosvleocks39oakfjfrgeq` (USER_PASSWORD_AUTH, 60-minute tokens), users `judge` and `rudo-demo`. Passwords are not in this repository. A request without a token gets 401.
- Books: DynamoDB table `imali-ai-alexa-books`, one item per shop. Callers pick a shop with the header `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Shop`; without it everyone shares `demo`.

## Redeploy

Commit, then run `deploy/agentcore.sh` from the repository root. It builds an ARM64 image from a clean copy of HEAD (uncommitted changes are not shipped), updates the runtime, waits for READY and writes the ids to `deploy/agentcore.out.json`. `scripts/smoke.mjs` checks it end to end.

## Measured: tool calls under 1 s, cold starts about 7 s

Milliseconds per step, measured on 23 Oct 2026 from a desktop in Korea (each call includes the round trip to Virginia). Runs 3 and 4 followed a redeploy, so most of their `initialize` calls were cold starts.

| Step | Run 1 | Run 2 | Run 3 | Run 4 |
| --- | --- | --- | --- | --- |
| initialize | 2269 | 2186 | 7122 | 7146 |
| tools/list | 1197 | 1181 | 1180 | 1137 |
| record_sale | 589 | 577 | 602 | 601 |
| reorder_stock, confirmed | 944 | 935 | 912 | 957 |
| second initialize | 1303 | 1270 | 6561 | 1329 |
| get_customer_tabs | 600 | 573 | 602 | 636 |

## Cost controls

Idle sessions end after 300 s; a microVM lives at most 3,600 s. The table is on demand. ECR keeps the last 5 images.

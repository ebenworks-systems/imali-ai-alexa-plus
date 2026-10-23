#!/usr/bin/env bash
# Deploys the hosted copy of the simulated Alexa+ screen to Vercel from a clean copy of the commit.
# The hosted page talks to the MCP server on AgentCore (ids from deploy/agentcore.out.json) and to the model relay
# in api/agent/chat.js, which answers only callers signed in to the same Cognito pool. Keys live in the Vercel
# project's environment, never in the repository. Needs a checkout linked with `vercel link`.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit first: the working tree has changes." >&2
  exit 1
fi
STATE=deploy/agentcore.out.json
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git archive HEAD | tar -x -C "$tmp"
(cd "$tmp" && npm ci --no-audit --no-fund --silent && node scripts/build-web.mjs)
python3 - "$STATE" "$tmp/web/config.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
config = {"hosted": True, "mcpUrl": s["mcpUrl"], "aws": {"mcpUrl": s["mcpUrl"], "cognitoRegion": s["region"], "cognitoClientId": s["clientId"]}, "model": {"relay": True, "name": "sonnet"}}
json.dump(config, open(sys.argv[2], "w"))
PY
printf 'node_modules\ntest\ntools\ndeploy\ndocs\nsubmission\nskills\nscripts\nui\n' > "$tmp/.vercelignore"
mkdir -p "$tmp/.vercel"
cp .vercel/project.json "$tmp/.vercel/"
echo "Deploying $(git rev-parse --short HEAD) to production"
(cd "$tmp" && vercel deploy --prod --yes)

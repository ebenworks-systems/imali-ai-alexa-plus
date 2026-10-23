#!/usr/bin/env bash
# Deploys the MCP server to Amazon Bedrock AgentCore Runtime in us-east-1 with the plain AWS CLI.
# Idempotent: each step makes its resource only when it is missing. Run from the repository root:
#
#   deploy/agentcore.sh            # table, sign-in pool, image, runtime; prints the MCP URL
#
# The IAM role the runtime assumes (ImaliAiAlexaAgentCoreRole: pull this image, write its logs, read and
# write the books table) is made once by an administrator; this script only passes it.
set -euo pipefail

REGION=${AWS_REGION:-us-east-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO=imali-ai-alexa-mcp
TABLE=imali-ai-alexa-books
POOL_NAME=imali-ai-alexa-owners
CLIENT_NAME=imali-ai-alexa-simulator
RUNTIME_NAME=imali_ai_alexa_mcp
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/ImaliAiAlexaAgentCoreRole"
TAG=$(git rev-parse --short HEAD)
IMAGE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"
STATE=deploy/agentcore.out.json   # ids of what this script made; not committed
aws_() { aws --region "$REGION" "$@"; }
say() { printf '\n== %s\n' "$*"; }

say "Books table ${TABLE} (DynamoDB, on demand)"
if ! aws_ dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  aws_ dynamodb create-table --table-name "$TABLE" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=shop,AttributeType=S --key-schema AttributeName=shop,KeyType=HASH \
    --tags Key=project,Value=imali-ai-alexa-hackathon >/dev/null
  aws_ dynamodb wait table-exists --table-name "$TABLE"
fi

say "Sign-in pool ${POOL_NAME} (Amazon Cognito) for the runtime's JWT authorizer"
POOL_ID=$(aws_ cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text)
if [ "$POOL_ID" = "None" ] || [ -z "$POOL_ID" ]; then
  POOL_ID=$(aws_ cognito-idp create-user-pool --pool-name "$POOL_NAME" \
    --policies 'PasswordPolicy={MinimumLength=12,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}' \
    --admin-create-user-config AllowAdminCreateUserOnly=true --query UserPool.Id --output text)
fi
CLIENT_ID=$(aws_ cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" --output text)
if [ "$CLIENT_ID" = "None" ] || [ -z "$CLIENT_ID" ]; then
  CLIENT_ID=$(aws_ cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" --client-name "$CLIENT_NAME" --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH --access-token-validity 60 --token-validity-units AccessToken=minutes \
    --query UserPoolClient.ClientId --output text)
fi
DISCOVERY="https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}/.well-known/openid-configuration"

say "Image ${IMAGE} (ARM64, production packages only, from a clean copy of ${TAG})"
aws_ ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1 || \
  aws_ ecr create-repository --repository-name "$REPO" --image-scanning-configuration scanOnPush=true >/dev/null
aws_ ecr put-lifecycle-policy --repository-name "$REPO" --lifecycle-policy-text \
  '{"rules":[{"rulePriority":1,"description":"keep the last 5 images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}' >/dev/null
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD | tar -x -C "$STAGE"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)
docker pull -q --platform linux/arm64 node:22-slim >/dev/null
DOCKER_BUILDKIT=0 docker build -q --platform linux/arm64 -f "$STAGE/deploy/Dockerfile" -t "$IMAGE" "$STAGE" >/dev/null
aws_ ecr get-login-password | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com" >/dev/null
docker push -q "$IMAGE" >/dev/null
docker logout "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com" >/dev/null   # do not leave the 12-hour ECR token in ~/.docker/config.json

say "Runtime ${RUNTIME_NAME} (AgentCore Runtime, protocol MCP, JWT sign-in, stateful sessions)"
ARTIFACT="{\"containerConfiguration\":{\"containerUri\":\"${IMAGE}\"}}"
AUTH="{\"customJWTAuthorizer\":{\"discoveryUrl\":\"${DISCOVERY}\",\"allowedClients\":[\"${CLIENT_ID}\"]}}"
HEADERS='{"requestHeaderAllowlist":["Authorization","X-Amzn-Bedrock-AgentCore-Runtime-Custom-Shop"]}'
RUNTIME_ID=$(aws_ bedrock-agentcore-control list-agent-runtimes --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId | [0]" --output text)
if [ "$RUNTIME_ID" = "None" ] || [ -z "$RUNTIME_ID" ]; then
  RUNTIME_ID=$(aws_ bedrock-agentcore-control create-agent-runtime --agent-runtime-name "$RUNTIME_NAME" \
    --description "Imali AI shop books: MCP server for the Amazon Developer Hackathon (Alexa+ track)" \
    --agent-runtime-artifact "$ARTIFACT" --role-arn "$ROLE_ARN" --network-configuration networkMode=PUBLIC \
    --protocol-configuration serverProtocol=MCP --authorizer-configuration "$AUTH" \
    --request-header-configuration "$HEADERS" \
    --lifecycle-configuration idleRuntimeSessionTimeout=300,maxLifetime=3600 \
    --query agentRuntimeId --output text)
else
  aws_ bedrock-agentcore-control update-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
    --agent-runtime-artifact "$ARTIFACT" --role-arn "$ROLE_ARN" --network-configuration networkMode=PUBLIC \
    --protocol-configuration serverProtocol=MCP --authorizer-configuration "$AUTH" \
    --request-header-configuration "$HEADERS" \
    --lifecycle-configuration idleRuntimeSessionTimeout=300,maxLifetime=3600 >/dev/null
fi
for _ in $(seq 1 60); do
  STATUS=$(aws_ bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query status --output text)
  [ "$STATUS" = "READY" ] && break
  case "$STATUS" in *FAILED*) echo "runtime $STATUS"; aws_ bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query failureReason --output text; exit 1;; esac
  sleep 5
done
RUNTIME_ARN=$(aws_ bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeArn --output text)
ENCODED=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "$RUNTIME_ARN")
MCP_URL="https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${ENCODED}/invocations?qualifier=DEFAULT"

cat > "$STATE" <<EOF
{"region":"${REGION}","table":"${TABLE}","userPoolId":"${POOL_ID}","clientId":"${CLIENT_ID}","runtimeId":"${RUNTIME_ID}","runtimeArn":"${RUNTIME_ARN}","image":"${IMAGE}","mcpUrl":"${MCP_URL}","status":"${STATUS}"}
EOF
say "Done: ${STATUS}"
echo "MCP URL: ${MCP_URL}"
echo "Sign-in: Cognito pool ${POOL_ID}, app client ${CLIENT_ID} (USER_PASSWORD_AUTH); see deploy/AWS-NOTES.md"

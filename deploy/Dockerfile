# The MCP server for Amazon Bedrock AgentCore Runtime: ARM64, listening on 0.0.0.0:8000 at /mcp.
# Built by deploy/agentcore.sh from a clean copy of the commit with production packages only.
# No RUN steps, so the image builds for ARM64 on an x86 machine without an emulator.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    AGENTCORE=1 \
    SERVE_WEB=0 \
    PORT=8000 \
    HOST=0.0.0.0 \
    TRUST_PLATFORM_JWT=1 \
    IMALI_STORE=dynamodb \
    IMALI_TABLE=imali-ai-alexa-books \
    AWS_REGION=us-east-1
COPY package.json package-lock.json ./
COPY node_modules ./node_modules
COPY src ./src
COPY ui ./ui
USER node
EXPOSE 8000
CMD ["node", "src/index.js"]

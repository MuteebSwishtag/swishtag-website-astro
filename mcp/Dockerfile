FROM node:24-bookworm-slim
ENV NODE_ENV=production MCP_HOST=0.0.0.0 MCP_PORT=3100 MCP_CONFIG_PATH=/run/mcp/config.json MCP_AUDIT_PATH=/var/lib/mcp/audit.jsonl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /var/lib/mcp && chown node:node /var/lib/mcp
COPY --chown=node:node src ./src
USER node
EXPOSE 3100
CMD ["node", "src/server.mjs"]

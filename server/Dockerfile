FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node --input-type=module -e "const response=await fetch('http://127.0.0.1:8787/health'); if(!response.ok) process.exit(1); const body=await response.json(); if(!body.ok || body.schema_version !== body.expected_schema_version) process.exit(1)"

CMD ["node", "--env-file-if-exists=.env", "--experimental-sqlite", "src/index.mjs"]

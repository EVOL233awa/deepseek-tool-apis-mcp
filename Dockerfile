FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./server.mjs

USER node

ENTRYPOINT ["node", "/app/server.mjs"]

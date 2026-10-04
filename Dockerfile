FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY worker.js index.html style.css app.js.txt local-verify.mjs verify.mjs ./
ENV LOCAL_HOST=0.0.0.0 LOCAL_PORT=8787
USER node
EXPOSE 8787
CMD ["node", "local-verify.mjs"]

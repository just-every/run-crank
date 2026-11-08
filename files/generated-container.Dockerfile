FROM node:26.8.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates && apt-get clean
RUN mkdir -p /private /archive
WORKDIR /runtime
COPY runtime/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY runtime/ /runtime/
COPY app/ /app/
ENV NODE_ENV=production PORT=8080 WRANGLER_SEND_METRICS=false
EXPOSE 8080
VOLUME /data
ENTRYPOINT ["sh", "/runtime/modules/container/entrypoint.sh"]

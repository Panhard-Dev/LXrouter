FROM node:22-bookworm-slim

WORKDIR /opt/9router

COPY package.json cli.js LICENSE README.md ./
COPY src ./src
COPY hooks ./hooks
COPY app ./app
COPY tools ./tools
COPY init-key.sh init-key.js ./

RUN npm install --omit=dev

ENV NODE_ENV=production \
    PORT=20128 \
    HOSTNAME=0.0.0.0

EXPOSE 20128

VOLUME ["/root/.9router"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:20128').then(r=>process.exit(0)).catch(()=>process.exit(1))"

CMD ["./init-key.sh"]

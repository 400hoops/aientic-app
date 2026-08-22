# ---- build the frontend -------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- runtime: express serves the API and the built assets ---------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev
COPY server ./server
COPY --from=web /app/dist ./dist

# Run as the image's unprivileged user. /data is created (and owned) up
# front so a bind-mounted or named volume inherits permissions the node
# user can actually write to.
RUN mkdir -p /data && chown node:node /data
USER node

ENV AIENTIC_DATA_DIR=/data
ENV AIENTIC_PORT=8080
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server/index.js"]

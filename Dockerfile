# ---- build the frontend -------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
# The artifact detector is imported by both halves of the app, so it lives
# outside src/ and has to be copied into both stages. Leaving it out of this
# one is a build failure; leaving it out of the runtime stage below is worse,
# because that one only shows up when the server starts.
COPY shared ./shared
RUN npm run build

# ---- runtime: express serves the API and the built assets ---------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev
COPY server ./server
COPY shared ./shared
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

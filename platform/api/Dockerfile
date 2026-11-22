FROM node:22-alpine
WORKDIR /app
COPY platform/api/package.json ./package.json
RUN npm install --omit=dev
COPY platform/api/server.js ./server.js
COPY platform/api/schema.sql ./schema.sql
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]

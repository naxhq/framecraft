# Build context is apps/web itself (see docker-compose.yml): this app is
# self-contained once packages/contracts has generated lib/contracts.ts.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, so
# the build-arg must be set before `npm run build`, not only at runtime.
ARG NEXT_PUBLIC_BAKE_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_BAKE_API_URL=$NEXT_PUBLIC_BAKE_API_URL

RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start"]

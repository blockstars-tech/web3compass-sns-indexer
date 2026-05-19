# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Put cert where all libs can read it
RUN mkdir -p /etc/ssl/certs/aws

# ⬇️ Copy your repo PEM into the image
COPY ./global-bundle.pem /etc/ssl/certs/aws/global-bundle.pem
USER node
CMD ["node", "dist/main.js"]

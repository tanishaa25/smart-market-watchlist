# Frontend — built with Vite, served as static files via nginx.
# Multi-stage: the build stage's node_modules and source never end up
# in the final image, only the compiled dist/ output.

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS serve
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

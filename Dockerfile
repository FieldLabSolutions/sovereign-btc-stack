FROM node:20-alpine
WORKDIR /app
COPY server.js config.json package.json ./
COPY public ./public
ENV PORT=3880
EXPOSE 3880
CMD ["node","server.js"]

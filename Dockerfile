# Node <= 24
FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

RUN npx prisma generate

EXPOSE 8000

CMD ["npm", "run", "worker"]
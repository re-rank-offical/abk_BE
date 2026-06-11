# Build stage - 모든 의존성으로 빌드
FROM node:18-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for nest build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage - Playwright 이미지 사용 (Chromium 시스템 라이브러리 포함)
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# Set environment variables
ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# 설치된 playwright-core 드라이버 버전과 일치하는 Chromium 설치
# (베이스 이미지 버전과 npm 패키지 버전이 어긋나도 launch 실패하지 않도록 보장)
RUN npx playwright-core install --with-deps chromium

# CloakBrowser 스텔스 Chromium 바이너리 다운로드
RUN npx cloakbrowser install

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "dist/main"]

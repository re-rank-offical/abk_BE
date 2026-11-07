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

# init 프로세스(tini) — Node가 PID 1이면 Chromium 고아/좀비 프로세스를 수거하지 못해
# 장기 가동 시 프로세스 테이블 고갈(fork EAGAIN)로 브라우저 실행이 전부 실패한다
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3000

# Start the application (tini가 PID 1로서 좀비 프로세스 수거)
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/main"]

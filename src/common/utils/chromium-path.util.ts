import * as fs from 'fs';
import { execSync } from 'child_process';
import { Logger } from '@nestjs/common';

const logger = new Logger('ChromiumPath');

/**
 * 배포 환경에서 사용 가능한 Chromium 실행 파일 경로를 탐색한다.
 *
 * 탐색 순서:
 *  1. CHROMIUM_PATH 환경변수
 *  2. 시스템에 설치된 chromium / google-chrome (which)
 *  3. Playwright 번들 Chromium (PLAYWRIGHT_BROWSERS_PATH)
 *  4. undefined → Playwright 내부 기본값 사용 (로컬 개발 환경)
 */
export function resolveChromiumPath(): string | undefined {
  // 1. 환경변수로 직접 지정된 경로
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    logger.log(`환경변수 CHROMIUM_PATH 사용: ${process.env.CHROMIUM_PATH}`);
    return process.env.CHROMIUM_PATH;
  }

  // 2. 시스템 chromium 찾기 (nixpacks / Docker 환경)
  try {
    const systemChromium = execSync(
      'which chromium || which chromium-browser || which google-chrome',
      { encoding: 'utf-8' },
    ).trim();
    if (systemChromium && fs.existsSync(systemChromium)) {
      logger.log(`시스템 Chromium 발견: ${systemChromium}`);
      return systemChromium;
    }
  } catch {
    logger.log('시스템 Chromium을 찾을 수 없음');
  }

  // 3. Playwright 번들 Chromium 경로 확인
  const playwrightPath =
    process.env.PLAYWRIGHT_BROWSERS_PATH || '/app/.cache/ms-playwright';
  const possiblePaths = [
    `${playwrightPath}/chromium-1200/chrome-linux64/chrome`,
    `${playwrightPath}/chromium-1200/chrome-linux/chrome`,
    `${playwrightPath}/chromium_headless_shell-1200/chrome-linux64/headless_shell`,
  ];

  for (const path of possiblePaths) {
    if (fs.existsSync(path)) {
      logger.log(`Playwright Chromium 발견: ${path}`);
      return path;
    }
  }

  // 4. 찾지 못하면 undefined (Playwright 기본값 사용 – 로컬 개발 환경)
  logger.log('Chromium 경로를 찾지 못함 – Playwright 기본값 사용');
  return undefined;
}

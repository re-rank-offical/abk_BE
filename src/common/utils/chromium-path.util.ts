import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Logger } from '@nestjs/common';
import { chromium } from 'playwright-core';

const logger = new Logger('ChromiumPath');

/**
 * 배포 환경에서 사용 가능한 Chromium 실행 파일 경로를 탐색한다.
 *
 * 탐색 순서:
 *  1. CHROMIUM_PATH 환경변수
 *  2. 설치된 playwright-core 드라이버가 기대하는 번들 Chromium (버전 일치 보장)
 *  3. 시스템에 설치된 chromium / google-chrome (which)
 *  4. PLAYWRIGHT_BROWSERS_PATH 하위 chromium-* 리비전 동적 탐색
 *  5. undefined → Playwright 내부 기본값 사용 (로컬 개발 환경)
 */
export function resolveChromiumPath(): string | undefined {
  // 1. 환경변수로 직접 지정된 경로
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    logger.log(`환경변수 CHROMIUM_PATH 사용: ${process.env.CHROMIUM_PATH}`);
    return process.env.CHROMIUM_PATH;
  }

  // 2. 드라이버 버전과 일치하는 번들 Chromium (리비전 불일치 방지를 위해 최우선)
  try {
    const bundledPath = chromium.executablePath();
    if (bundledPath && fs.existsSync(bundledPath)) {
      logger.log(`Playwright 번들 Chromium 사용: ${bundledPath}`);
      return bundledPath;
    }
  } catch {
    // 번들 경로를 계산할 수 없으면 다음 단계로 진행
  }

  // 3. 시스템 chromium 찾기 (nixpacks / Docker 환경)
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

  // 4. PLAYWRIGHT_BROWSERS_PATH 하위에서 chromium-* 리비전 동적 탐색 (최후 수단)
  const browsersRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH || '/app/.cache/ms-playwright';
  try {
    const revisions = fs
      .readdirSync(browsersRoot)
      .filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
      // 일반 chromium 우선, 같은 종류면 높은 리비전 우선
      .sort((a, b) => {
        const aShell = a.includes('_headless_shell') ? 1 : 0;
        const bShell = b.includes('_headless_shell') ? 1 : 0;
        if (aShell !== bShell) return aShell - bShell;
        return (
          Number(b.split('-').pop() ?? 0) - Number(a.split('-').pop() ?? 0)
        );
      });

    for (const revision of revisions) {
      const candidates = [
        path.join(browsersRoot, revision, 'chrome-linux64', 'chrome'),
        path.join(browsersRoot, revision, 'chrome-linux', 'chrome'),
        path.join(browsersRoot, revision, 'chrome-linux64', 'headless_shell'),
        path.join(browsersRoot, revision, 'chrome-linux', 'headless_shell'),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          logger.log(`Playwright Chromium 발견: ${candidate}`);
          return candidate;
        }
      }
    }
  } catch {
    // 브라우저 디렉토리가 없으면 무시하고 다음 단계로
  }

  // 5. 찾지 못하면 undefined (Playwright 기본값 사용 – 로컬 개발 환경)
  logger.log('Chromium 경로를 찾지 못함 – Playwright 기본값 사용');
  return undefined;
}

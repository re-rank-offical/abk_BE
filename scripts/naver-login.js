/* eslint-disable */
/**
 * 네이버 세션 쿠키 자동 저장 스크립트.
 *
 * 사용법 (abk_Back 폴더에서):
 *   npm run naver-login            # 네이버 사이트가 1개면 자동 선택
 *   npm run naver-login -- eruvins # 블로그 ID(또는 사이트명 일부)로 지정
 *
 * 동작:
 *   1) 크롬 창이 열리고 네이버 로그인 페이지로 이동합니다.
 *   2) 사용자가 직접 로그인(+캡차/2차인증)하면 됩니다.
 *   3) 로그인이 감지되면 세션 쿠키(NID_AUT, NID_SES 등)를 자동으로 추출해
 *      해당 네이버 사이트의 sessionCookies에 저장하고 창을 닫습니다.
 *
 * 쿠키값을 직접 찾아 복사할 필요가 없습니다.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { Client } = require('pg');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const line = fs
      .readFileSync(envPath, 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('DATABASE_URL='));
    if (line) return line.slice(line.indexOf('=') + 1).trim();
  }
  throw new Error('DATABASE_URL을 찾을 수 없습니다 (.env 또는 환경변수).');
}

async function launchBrowser() {
  // 로컬에 설치된 크롬/엣지를 사용 (playwright 브라우저 바이너리 불필요)
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ headless: false, channel });
    } catch (_) {
      /* 다음 채널 시도 */
    }
  }
  // 폴백: 기본 chromium (설치돼 있어야 함)
  return chromium.launch({ headless: false });
}

async function main() {
  const arg = (process.argv[2] || '').trim().toLowerCase();

  const db = new Client({
    connectionString: loadDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  // 대상 네이버 사이트 선택
  const { rows } = await db.query(
    `SELECT id, "siteName", "siteUrl" FROM authority_sites WHERE "siteType" = 'NAVER' ORDER BY "createdAt"`,
  );
  if (rows.length === 0) {
    console.error('등록된 네이버 사이트가 없습니다. 먼저 사이트를 추가하세요.');
    await db.end();
    process.exit(1);
  }

  let site;
  if (arg) {
    site = rows.find(
      (r) =>
        (r.siteUrl || '').toLowerCase().includes(arg) ||
        (r.siteName || '').toLowerCase().includes(arg),
    );
    if (!site) {
      console.error(`"${arg}"에 해당하는 네이버 사이트를 찾지 못했습니다.`);
      console.error(
        '사이트 목록:\n' +
          rows.map((r) => `  - ${r.siteName} (${r.siteUrl})`).join('\n'),
      );
      await db.end();
      process.exit(1);
    }
  } else if (rows.length === 1) {
    site = rows[0];
  } else {
    console.error('네이버 사이트가 여러 개입니다. 블로그 ID를 지정하세요:');
    console.error(
      rows.map((r) => `  npm run naver-login -- ${r.siteUrl}`).join('\n'),
    );
    await db.end();
    process.exit(1);
  }

  console.log(`\n대상 사이트: ${site.siteName} (${site.siteUrl})`);
  console.log('크롬 창을 엽니다. 네이버에 직접 로그인해 주세요...\n');

  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });
  const page = await context.newPage();
  await page.goto('https://nid.naver.com/nidlogin.login?mode=form', {
    waitUntil: 'domcontentloaded',
  });

  // 서버(다른 IP)에서도 세션이 쓰이도록 IP보안 OFF, 로그인 상태 유지 ON
  try {
    await page.evaluate(() => {
      const stay = document.getElementById('loginStay');
      const ipc = document.getElementById('switchIP');
      if (stay && !stay.checked) stay.click();
      if (ipc && ipc.checked) ipc.click();
    });
  } catch (_) {
    /* 폼이 아직 안 떴으면 무시 */
  }

  // 로그인 완료(NID_AUT 쿠키 생성)까지 최대 5분 대기
  const deadline = Date.now() + 5 * 60 * 1000;
  let saved = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    let cookies;
    try {
      cookies = await context.cookies('https://www.naver.com');
    } catch (_) {
      continue;
    }
    if (!cookies.some((c) => c.name === 'NID_AUT')) continue;

    // blog.naver.com까지 유효한 .naver.com 도메인 쿠키만 저장
    const keep = cookies
      .filter((c) => (c.domain || '') === '.naver.com')
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        expires:
          typeof c.expires === 'number' && c.expires > 0
            ? Math.floor(c.expires)
            : -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite || 'Lax',
      }));

    await db.query(
      `UPDATE authority_sites SET "sessionCookies" = $1, "updatedAt" = now() WHERE id = $2`,
      [JSON.stringify(keep), site.id],
    );
    saved = true;
    console.log(
      `\n✅ 로그인 감지! 쿠키 ${keep.length}개를 "${site.siteName}"에 저장했습니다.`,
    );
    console.log('이제 자동발행에서 네이버로 바로 발행할 수 있습니다.');
    break;
  }

  if (!saved) {
    console.error(
      '\n⏱️ 5분 안에 로그인이 감지되지 않았습니다. 다시 실행해 주세요.',
    );
  }

  await browser.close();
  await db.end();
  process.exit(saved ? 0 : 1);
}

main().catch((err) => {
  console.error('오류:', err.message || err);
  process.exit(1);
});

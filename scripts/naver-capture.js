/* eslint-disable */
/**
 * 네이버 로그인 창을 띄워 세션 쿠키(NID_AUT, NID_SES 등)를 자동 추출해
 * 해당 네이버 사이트(authority_sites)에 저장하는 공용 로직.
 * CLI(naver-login.js)와 로컬 도우미 서버(naver-helper.js)가 함께 사용한다.
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
  return chromium.launch({ headless: false });
}

/**
 * @param {object} opts
 * @param {string} [opts.arg]        블로그 ID/사이트명 일부 (없으면 모든 네이버 사이트)
 * @param {number} [opts.timeoutMs]  로그인 대기 제한 (기본 5분)
 * @param {(msg:string)=>void} [opts.onStatus] 진행 상태 콜백
 * @returns {Promise<{success:boolean, message:string, savedCount:number, siteNames:string[]}>}
 */
async function captureAndSave({ arg = '', timeoutMs = 5 * 60 * 1000, onStatus = () => {} } = {}) {
  const needle = (arg || '').trim().toLowerCase();
  const db = new Client({
    connectionString: loadDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  let browser = null;
  try {
    const { rows } = await db.query(
      `SELECT id, "siteName", "siteUrl" FROM authority_sites WHERE "siteType" = 'NAVER' ORDER BY "createdAt"`,
    );
    if (rows.length === 0) {
      return { success: false, message: '등록된 네이버 사이트가 없습니다. 먼저 사이트를 추가하세요.', savedCount: 0, siteNames: [] };
    }

    // 쿠키는 네이버 계정 단위라 같은 계정의 여러 사이트에 공용 저장
    const targets = needle
      ? rows.filter(
          (r) =>
            (r.siteUrl || '').toLowerCase().includes(needle) ||
            (r.siteName || '').toLowerCase().includes(needle),
        )
      : rows;
    if (targets.length === 0) {
      return { success: false, message: `"${arg}"에 해당하는 네이버 사이트를 찾지 못했습니다.`, savedCount: 0, siteNames: [] };
    }

    onStatus(`크롬 창을 엽니다. 네이버에 직접 로그인해 주세요... (대상: ${targets.map((t) => t.siteName).join(', ')})`);

    browser = await launchBrowser();
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

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      let cookies;
      try {
        cookies = await context.cookies('https://www.naver.com');
      } catch (_) {
        continue;
      }
      if (!cookies.some((c) => c.name === 'NID_AUT')) continue;

      const keep = cookies
        .filter((c) => (c.domain || '') === '.naver.com')
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : -1,
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: c.sameSite || 'Lax',
        }));

      const cookieJson = JSON.stringify(keep);
      for (const t of targets) {
        await db.query(
          `UPDATE authority_sites SET "sessionCookies" = $1, "updatedAt" = now() WHERE id = $2`,
          [cookieJson, t.id],
        );
      }
      const siteNames = targets.map((t) => t.siteName);
      return {
        success: true,
        message: `쿠키 ${keep.length}개를 ${siteNames.length}개 사이트(${siteNames.join(', ')})에 저장했습니다.`,
        savedCount: keep.length,
        siteNames,
      };
    }

    return { success: false, message: '제한 시간 안에 로그인이 감지되지 않았습니다. 다시 시도해 주세요.', savedCount: 0, siteNames: [] };
  } finally {
    try {
      await browser?.close();
    } catch (_) {
      /* ignore */
    }
    await db.end();
  }
}

module.exports = { captureAndSave, loadDatabaseUrl };

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

/** HTML 본문을 네이버 에디터 입력용 평문 줄 배열로 변환 */
function htmlToLines(html) {
  const text = String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.split('\n');
}

/**
 * 네이버 블로그에 "보이는 브라우저"로 글을 발행한다 (사용자가 화면을 지켜봄, 입력은 AI).
 * QA로 검증된 셀렉터/절차 사용.
 * @param {object} opts { arg, title, body, timeoutMs, onStatus }
 * @returns {Promise<{success:boolean, message:string, url?:string}>}
 */
async function publishPost({ arg = '', title = '', body = '', timeoutMs = 8 * 60 * 1000, onStatus = () => {} } = {}) {
  const needle = (arg || '').trim().toLowerCase();
  if (!title.trim()) return { success: false, message: '제목이 비어 있습니다.' };

  const db = new Client({ connectionString: loadDatabaseUrl(), ssl: { rejectUnauthorized: false } });
  await db.connect();
  let browser = null;
  try {
    const { rows } = await db.query(
      `SELECT id, "siteName", "siteUrl", "sessionCookies", "userId" FROM authority_sites WHERE "siteType" = 'NAVER' ORDER BY "updatedAt" DESC`,
    );
    if (rows.length === 0) return { success: false, message: '등록된 네이버 사이트가 없습니다.' };
    // arg가 사이트 id면 정확히, 아니면 URL/이름 부분일치
    const site =
      rows.find((r) => r.id === arg) ||
      (needle
        ? rows.find((r) => (r.siteUrl || '').toLowerCase().includes(needle) || (r.siteName || '').toLowerCase().includes(needle))
        : rows[0]);
    if (!site) return { success: false, message: `"${arg}"에 해당하는 네이버 사이트를 찾지 못했습니다.` };

    const blogId = (site.siteUrl.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!blogId) return { success: false, message: '블로그 ID를 파싱할 수 없습니다.' };

    onStatus(`브라우저를 엽니다. 발행 과정을 화면에서 보실 수 있습니다. (${site.siteName})`);
    browser = await launchBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });

    // 저장된 세션 쿠키 복원
    if (site.sessionCookies) {
      try {
        await context.addCookies(JSON.parse(site.sessionCookies));
      } catch (_) {}
    }

    const page = await context.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));

    const writeUrl = `https://blog.naver.com/${blogId}?Redirect=Write&`;
    await page.goto(writeUrl, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // 로그인 페이지로 튕기면 → 사용자가 직접 로그인하도록 대기
    if (page.url().includes('nid.naver.com')) {
      onStatus('로그인이 필요합니다. 열린 창에서 네이버에 로그인해 주세요...');
      const deadline = Date.now() + 5 * 60 * 1000;
      let loggedIn = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(2000);
        const cookies = await context.cookies('https://www.naver.com').catch(() => []);
        if (cookies.some((c) => c.name === 'NID_AUT')) { loggedIn = true; break; }
      }
      if (!loggedIn) return { success: false, message: '로그인이 감지되지 않았습니다. 다시 시도해 주세요.' };
      // 로그인으로 얻은 쿠키 저장
      const fresh = (await context.cookies('https://www.naver.com'))
        .filter((c) => (c.domain || '') === '.naver.com')
        .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', expires: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : -1, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax' }));
      await db.query(`UPDATE authority_sites SET "sessionCookies" = $1, "updatedAt" = now() WHERE "siteType" = 'NAVER' AND "siteUrl" ILIKE $2`, [JSON.stringify(fresh), `%${blogId}%`]);
      await page.goto(writeUrl, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    const frameEl = await page.$('iframe#mainFrame, iframe[name="mainFrame"]');
    if (!frameEl) return { success: false, message: '에디터(iframe)를 찾을 수 없습니다.' };
    const frame = await frameEl.contentFrame();

    // 임시저장 복구 팝업: 취소(새 글)
    try {
      const c = await frame.$('.se-popup-button-cancel');
      if (c && (await c.isVisible())) { await c.click(); await page.waitForTimeout(800); }
    } catch (_) {}

    onStatus('제목을 입력합니다...');
    const titleEl = await frame.waitForSelector('.se-section-documentTitle .se-text-paragraph', { state: 'visible', timeout: 30000 });
    await titleEl.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(title, { delay: 12 });
    await page.waitForTimeout(500);

    onStatus('본문을 입력합니다...');
    const bodyEl = await frame.$('.se-component.se-text .se-text-paragraph');
    if (!bodyEl) return { success: false, message: '본문 입력 영역을 찾을 수 없습니다.' };
    await bodyEl.click();
    await page.waitForTimeout(300);
    const lines = htmlToLines(body);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.keyboard.type(lines[i], { delay: 5 });
      if (i < lines.length - 1) await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(800);

    onStatus('발행합니다...');
    // 상단 발행 → 설정 레이어의 확정 발행 (tpb*i.publish)
    await frame.click('button[data-click-area="tpb.publish"], button[class*="publish_btn"]');
    await frame.waitForSelector('button[data-click-area="tpb*i.publish"]', { state: 'visible', timeout: 12000 });
    await page.waitForTimeout(800);
    await frame.click('button[data-click-area="tpb*i.publish"]');

    // 발행 완료: 글 보기 URL로 이동 대기
    let publishedUrl = null;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const u = page.url();
      if (new RegExp(`blog\\.naver\\.com/${blogId}/\\d+`).test(u) || (!u.includes('Write') && !u.includes('PostWriteForm'))) {
        publishedUrl = u;
        break;
      }
    }
    if (!publishedUrl) return { success: false, message: '발행 확정 후에도 글쓰기 페이지에 머물러 있습니다.' };

    // 등록 이력(backlink_posts)에 성공 기록 남기기
    try {
      await db.query(
        `INSERT INTO backlink_posts (id, "authoritySiteId", title, body, status, "publishedUrl", "userId", "createdAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 'SUCCESS', $4, $5, now())`,
        [site.id, title, body, publishedUrl, site.userId || null],
      );
    } catch (e) {
      onStatus(`이력 기록 실패(발행은 성공): ${e.message || e}`);
    }

    await page.waitForTimeout(2000); // 사용자가 결과 화면을 볼 시간
    onStatus(`발행 완료: ${publishedUrl}`);
    return { success: true, message: `발행 완료`, url: publishedUrl };
  } finally {
    try { await browser?.close(); } catch (_) {}
    await db.end();
  }
}

module.exports = { captureAndSave, publishPost, loadDatabaseUrl, htmlToLines };

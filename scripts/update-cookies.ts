/**
 * 티스토리 세션 쿠키 수동 갱신 스크립트
 *
 * 사용법: npx ts-node scripts/update-cookies.ts <블로그명>
 * 예시:   npx ts-node scripts/update-cookies.ts re-rank
 *
 * 1. 브라우저가 열리면 카카오 로그인을 직접 완료하세요 (2FA 포함)
 * 2. 로그인 완료 후 터미널에서 Enter를 누르면 쿠키가 저장됩니다.
 */
import { chromium } from 'playwright-core';
import { Client } from 'pg';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config();

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const blogName = process.argv[2];
  if (!blogName) {
    console.error('사용법: npx ts-node scripts/update-cookies.ts <블로그명>');
    console.error('예시:   npx ts-node scripts/update-cookies.ts re-rank');
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error(
      'DATABASE_URL 환경변수가 필요합니다. .env 파일을 확인하세요.',
    );
    process.exit(1);
  }

  console.log(`\n[1/4] 브라우저 실행 중...`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  console.log(`[2/4] 티스토리 로그인 페이지로 이동합니다.`);
  console.log(`       → 카카오 로그인을 직접 완료하세요 (2FA 포함)`);
  console.log(
    `       → 로그인 후 ${blogName}.tistory.com 아무 페이지에 있으면 됩니다.\n`,
  );

  await page.goto(`https://www.tistory.com/auth/login`, {
    waitUntil: 'domcontentloaded',
  });

  await waitForEnter('       로그인을 완료했으면 Enter를 누르세요... ');

  const currentUrl = page.url();
  console.log(`\n[3/4] 현재 URL: ${currentUrl}`);

  if (currentUrl.includes('accounts.kakao.com')) {
    console.error('❌ 아직 카카오 로그인 페이지입니다. 다시 시도하세요.');
    await browser.close();
    process.exit(1);
  }

  // 로그인 후 블로그 관리 페이지로 이동하여 tistory 쿠키 확보
  console.log(`       ${blogName}.tistory.com 으로 이동하여 쿠키 확보 중...`);
  try {
    await page.goto(`https://${blogName}.tistory.com/manage/`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForTimeout(3000);
  } catch {
    // 이동 실패해도 쿠키는 추출 가능
  }

  console.log(`       쿠키를 추출하는 중...`);
  const cookies = await context.cookies();
  const cookieJson = JSON.stringify(cookies);
  console.log(
    `       쿠키 ${cookies.length}개 추출 완료 (${Math.round(cookieJson.length / 1024)}KB)\n`,
  );

  await browser.close();

  // DB 업데이트
  console.log(`[4/4] DB에 쿠키 저장 중...`);
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  // 먼저 DB에 어떤 TISTORY 사이트가 있는지 확인
  const allSites = await client.query(
    `SELECT "id", "siteName", "siteUrl" FROM authority_sites WHERE "siteType" = 'TISTORY'`,
  );
  console.log(`       DB 내 TISTORY 사이트 ${allSites.rowCount}개:`);
  for (const row of allSites.rows) {
    console.log(`         - ${row.siteName} (${row.siteUrl})`);
  }

  // siteUrl 또는 siteName으로 매칭 시도
  const result = await client.query(
    `UPDATE authority_sites
     SET "sessionCookies" = $1
     WHERE ("siteUrl" LIKE $2 OR "siteName" LIKE $3) AND "siteType" = 'TISTORY'
     RETURNING "id", "siteName", "siteUrl"`,
    [cookieJson, `%${blogName}%`, `%${blogName}%`],
  );

  await client.end();

  if (result.rowCount === 0) {
    console.error(`\n❌ "${blogName}" 사이트를 DB에서 찾지 못했습니다.`);
    console.log(`   추출된 쿠키 JSON (수동 저장용):\n`);
    console.log(cookieJson.substring(0, 200) + '...');
    process.exit(1);
  }

  for (const row of result.rows) {
    console.log(`   ✓ ${row.siteName} (${row.siteUrl}) – 쿠키 갱신 완료`);
  }

  console.log(`\n✅ 완료! 이제 자동 발행이 정상 동작합니다.`);
}

main().catch((err) => {
  console.error('에러:', err.message);
  process.exit(1);
});

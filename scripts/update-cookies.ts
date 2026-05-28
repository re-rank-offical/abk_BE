/**
 * 티스토리 세션 쿠키 수동 갱신 스크립트
 *
 * 사용법: npx ts-node scripts/update-cookies.ts <블로그명>
 * 예시:   npx ts-node scripts/update-cookies.ts re-rank
 *
 * 1. 브라우저가 열리면 카카오 로그인을 직접 완료하세요 (2FA 포함)
 * 2. 글쓰기 페이지가 보이면 자동으로 쿠키가 저장됩니다.
 */
import { chromium } from 'playwright-core';
import { Client } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

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

  const tistoryUrl = `https://${blogName}.tistory.com`;
  const writeUrl = `${tistoryUrl}/manage/newpost`;

  console.log(`\n[1/4] 브라우저 실행 중...`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  console.log(`[2/4] ${tistoryUrl} 로 이동합니다.`);
  console.log(`       → 카카오 로그인을 직접 완료하세요 (2FA 포함)\n`);

  await page.goto(`https://www.tistory.com/auth/login`, {
    waitUntil: 'domcontentloaded',
  });

  // 글쓰기 페이지에 도달할 때까지 대기 (최대 5분)
  console.log(`       로그인 완료 후 글쓰기 페이지 도달을 기다리는 중...`);
  console.log(`       (최대 5분 대기)\n`);

  try {
    await page.waitForURL(/manage\/(newpost|edit)/, { timeout: 300000 });
  } catch {
    // URL 패턴이 안 맞으면 수동으로 글쓰기 페이지로 이동
    console.log(`       글쓰기 페이지로 직접 이동합니다...`);
    await page.goto(writeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(5000);
  }

  const currentUrl = page.url();
  if (
    currentUrl.includes('auth/login') ||
    currentUrl.includes('accounts.kakao.com')
  ) {
    console.error('\n❌ 로그인이 완료되지 않았습니다. 다시 시도하세요.');
    await browser.close();
    process.exit(1);
  }

  console.log(`[3/4] 로그인 성공! URL: ${currentUrl}`);
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

  const result = await client.query(
    `UPDATE authority_sites
     SET "sessionCookies" = $1
     WHERE "siteUrl" LIKE $2 AND "siteType" = 'TISTORY'
     RETURNING "id", "siteName", "siteUrl"`,
    [cookieJson, `%${blogName}.tistory.com%`],
  );

  await client.end();

  if (result.rowCount === 0) {
    console.error(
      `\n❌ "${blogName}.tistory.com" 사이트를 DB에서 찾지 못했습니다.`,
    );
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

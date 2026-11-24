/* eslint-disable */
/**
 * 네이버 세션 쿠키 자동 저장 (CLI).
 *
 * 사용법 (abk_Back 폴더에서):
 *   npm run naver-login            # 모든 네이버 사이트에 저장
 *   npm run naver-login -- eruvins # 블로그 ID/사이트명 일부로 지정
 *
 * 크롬 창이 열리면 직접 로그인(+캡차/2차인증)만 하면,
 * 쿠키값을 직접 찾을 필요 없이 자동으로 추출·저장됩니다.
 */
const { captureAndSave } = require('./naver-capture');

captureAndSave({
  arg: process.argv[2] || '',
  onStatus: (msg) => console.log(msg),
})
  .then((res) => {
    console.log(res.success ? `\n✅ ${res.message}` : `\n❌ ${res.message}`);
    process.exit(res.success ? 0 : 1);
  })
  .catch((err) => {
    console.error('오류:', err.message || err);
    process.exit(1);
  });

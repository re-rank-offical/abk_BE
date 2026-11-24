/* eslint-disable */
/**
 * 네이버 로그인 로컬 도우미 서버.
 *
 * 사용법 (abk_Back 폴더에서):
 *   npm run naver-helper
 *
 * 이 프로세스를 켜 두면, 웹앱(https://abk-fn.vercel.app/backlink-sites)의
 * "네이버 로그인(쿠키 자동 저장)" 버튼이 이 도우미(localhost:4599)를 호출해
 * 크롬 창을 띄우고, 사용자가 직접 로그인하면 쿠키를 자동 추출·저장합니다.
 *
 * (Railway 서버는 화면이 없어 브라우저 창을 띄울 수 없으므로, 로그인 창은
 *  사용자 PC의 이 도우미에서 띄웁니다.)
 */
const express = require('express');
const { captureAndSave } = require('./naver-capture');

const PORT = Number(process.env.NAVER_HELPER_PORT) || 4599;
const ALLOW_ORIGINS = [
  'https://abk-fn.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

const app = express();
app.use(express.json());

// CORS (웹앱 origin 허용, preflight 처리)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

let running = false;

app.get('/ping', (_req, res) => res.json({ ok: true, busy: running }));

app.post('/naver-login', async (req, res) => {
  if (running) {
    return res
      .status(409)
      .json({ success: false, message: '이미 로그인 창이 열려 있습니다. 먼저 완료해 주세요.' });
  }
  running = true;
  const site = (req.body && req.body.site) || '';
  console.log(`[naver-helper] 로그인 요청 (site="${site || '전체'}")`);
  try {
    const result = await captureAndSave({
      arg: site,
      onStatus: (msg) => console.log('[naver-helper]', msg),
    });
    console.log('[naver-helper]', result.success ? '성공' : '실패', '-', result.message);
    res.json(result);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[naver-helper] 오류:', message);
    res.status(500).json({ success: false, message });
  } finally {
    running = false;
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n네이버 로그인 도우미 실행 중 → http://localhost:${PORT}`);
  console.log('이 창을 켜 둔 채로, 웹앱에서 "네이버 로그인" 버튼을 누르세요.');
  console.log('(종료: Ctrl+C)\n');
});

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { chromium, Browser } from 'playwright-core';
import * as fs from 'fs';
import { execSync } from 'child_process';
import {
  KeywordRanking,
  SearchEngine,
} from '../database/entities/keyword-ranking.entity';
import { MediaAnalytics } from '../database/entities/media-analytics.entity';
import { TrafficSnapshot } from '../database/entities/traffic-snapshot.entity';
import { MediaPlatform } from '../database/entities/media-connection.entity';
import { MediaConnection } from '../database/entities/media-connection.entity';
import { AnalyticsService } from './analytics.service';

interface NaverSearchResult {
  rank: number;
  title: string;
  url: string;
  description: string;
}

interface BlogStats {
  totalPosts: number;
  totalViews: number;
  todayVisitors: number;
  subscribers?: number;
}

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);
  private browser: Browser | null = null;

  constructor(
    @InjectRepository(KeywordRanking)
    private keywordRankingRepository: Repository<KeywordRanking>,
    @InjectRepository(MediaAnalytics)
    private mediaAnalyticsRepository: Repository<MediaAnalytics>,
    @InjectRepository(TrafficSnapshot)
    private trafficSnapshotRepository: Repository<TrafficSnapshot>,
    @InjectRepository(MediaConnection)
    private mediaConnectionRepository: Repository<MediaConnection>,
    private analyticsService: AnalyticsService,
  ) {}

  /**
   * 브라우저 인스턴스 가져오기
   */
  private async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      // fs, execSync는 top-level에서 import됨

      let execPath: string | undefined = undefined;

      // 1. 환경변수로 직접 지정된 경로 확인
      if (
        process.env.CHROMIUM_PATH &&
        fs.existsSync(process.env.CHROMIUM_PATH)
      ) {
        execPath = process.env.CHROMIUM_PATH;
        this.logger.log(`환경변수 CHROMIUM_PATH 사용: ${execPath}`);
      }

      // 2. 시스템 chromium 찾기
      if (!execPath) {
        try {
          const systemChromium = execSync(
            'which chromium || which chromium-browser || which google-chrome',
            { encoding: 'utf-8' },
          ).trim();
          if (systemChromium && fs.existsSync(systemChromium)) {
            execPath = systemChromium;
            this.logger.log(`시스템 Chromium 발견: ${execPath}`);
          }
        } catch {
          this.logger.log('시스템 Chromium을 찾을 수 없음');
        }
      }

      // 3. Playwright 번들 Chromium 경로 확인
      if (!execPath) {
        const playwrightPath =
          process.env.PLAYWRIGHT_BROWSERS_PATH || '/app/.cache/ms-playwright';
        const possiblePaths = [
          `${playwrightPath}/chromium-1200/chrome-linux64/chrome`,
          `${playwrightPath}/chromium-1200/chrome-linux/chrome`,
        ];

        for (const path of possiblePaths) {
          if (fs.existsSync(path)) {
            execPath = path;
            this.logger.log(`Playwright Chromium 발견: ${execPath}`);
            break;
          }
        }
      }

      this.logger.log(
        `최종 브라우저 경로: ${execPath || 'Playwright 기본값 사용'}`,
      );

      this.browser = await chromium.launch({
        headless: true,
        executablePath: execPath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process',
        ],
      });
    }
    return this.browser;
  }

  /**
   * 브라우저 종료
   */
  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * 네이버 검색 순위 크롤링
   */
  async crawlNaverSearchRanking(
    keyword: string,
    targetUrl?: string,
    maxResults: number = 50,
  ): Promise<{ results: NaverSearchResult[]; targetRank: number | null }> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      // 네이버 검색 페이지 접속
      const searchUrl = `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(keyword)}`;
      await page.goto(searchUrl, { waitUntil: 'networkidle' });

      // 잠시 대기 (동적 콘텐츠 로딩)
      await page.waitForTimeout(2000);

      // 블로그 섹션 검색 결과 추출
      const results: NaverSearchResult[] = [];

      // 통합검색 결과에서 블로그 섹션 찾기
      const blogSection = await page.$(
        '#main_pack .blog_list, #main_pack .type_blog, .api_subject_bx',
      );

      if (blogSection) {
        const items = await blogSection.$$('.bx, .item, li');

        for (let i = 0; i < Math.min(items.length, maxResults); i++) {
          try {
            const titleEl = await items[i].$(
              '.title_link, .api_txt_lines, a.title',
            );
            const descEl = await items[i].$(
              '.dsc_txt, .api_txt_lines.dsc, .desc',
            );

            if (titleEl) {
              const title = (await titleEl.textContent()) || '';
              const url = (await titleEl.getAttribute('href')) || '';
              const description = descEl
                ? (await descEl.textContent()) || ''
                : '';

              results.push({
                rank: i + 1,
                title: title.trim(),
                url,
                description: description.trim(),
              });
            }
          } catch {
            // 개별 아이템 파싱 실패 시 무시
          }
        }
      }

      // 블로그 탭으로 이동하여 더 많은 결과 수집
      const blogTabUrl = `https://search.naver.com/search.naver?where=blog&query=${encodeURIComponent(keyword)}`;
      await page.goto(blogTabUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      const blogItems = await page.$$('.view_wrap, .total_tit, .api_txt_lines');

      for (
        let i = results.length;
        i < maxResults && i - results.length < blogItems.length;
        i++
      ) {
        try {
          const item = blogItems[i - results.length];
          const titleEl = await item.$('.title_link, .api_txt_lines, a');

          if (titleEl) {
            const title = (await titleEl.textContent()) || '';
            const url = (await titleEl.getAttribute('href')) || '';

            if (url && !results.some((r) => r.url === url)) {
              results.push({
                rank: results.length + 1,
                title: title.trim(),
                url,
                description: '',
              });
            }
          }
        } catch {
          // 무시
        }
      }

      // 타겟 URL 순위 찾기
      let targetRank: number | null = null;
      if (targetUrl) {
        const normalizedTarget = this.normalizeUrl(targetUrl);
        for (const result of results) {
          if (this.normalizeUrl(result.url).includes(normalizedTarget)) {
            targetRank = result.rank;
            break;
          }
        }
      }

      return { results, targetRank };
    } catch (error) {
      this.logger.error(`네이버 검색 크롤링 실패: ${error.message}`);
      throw error;
    } finally {
      await page.close();
    }
  }

  /**
   * 네이버 블로그 통계 크롤링 (로그인 필요)
   *
   * ⚠️ 주의: 웹 크롤링은 불안정하며, 다음과 같은 문제가 발생할 수 있습니다:
   * - 로그인 페이지 구조 변경
   * - CAPTCHA 또는 보안 인증 요구
   * - 네트워크 지연 또는 타임아웃
   *
   * 권장: 네이버 블로그 API 또는 RSS를 사용하세요.
   */
  async crawlNaverBlogStats(
    connection: MediaConnection,
  ): Promise<BlogStats | null> {
    if (!connection.username || !connection.password) {
      this.logger.warn(
        '네이버 블로그 크롤링: 인증 정보 없음. 매체 연동 설정에서 로그인 정보를 입력해주세요.',
      );
      return null;
    }

    // 블로그 ID 추출
    const blogId = this.extractNaverBlogId(connection.accountUrl || '');
    if (!blogId) {
      this.logger.warn(
        `네이버 블로그 ID 추출 실패: ${connection.accountUrl}. URL 형식: https://blog.naver.com/블로그ID`,
      );
      return null;
    }

    const browser = await this.getBrowser();
    const page = await browser.newPage();

    // 타임아웃 설정 증가
    page.setDefaultTimeout(60000); // 60초

    try {
      this.logger.log(
        `네이버 블로그 통계 수집 시작: ${connection.accountUrl} (블로그 ID: ${blogId})`,
      );

      // 네이버 로그인
      await page.goto('https://nid.naver.com/nidlogin.login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // 로그인 폼 입력 (keyboard.type()으로 캡챠 우회 시도)
      const idInput = await page
        .waitForSelector('#id', { timeout: 10000, state: 'attached' })
        .catch(() => null);

      if (!idInput) {
        this.logger.warn(
          '네이버 블로그 크롤링: 로그인 폼을 찾을 수 없습니다. 이미 로그인되어 있거나 페이지 구조가 변경되었습니다.',
        );
      } else {
        // 캡챠 우회를 위해 fill() 대신 keyboard.type() 사용
        await idInput.click();
        await page.keyboard.type(connection.username, { delay: 100 });

        const pwInput = await page.$('#pw');
        if (pwInput) {
          await pwInput.click();
          await page.keyboard.type(connection.password, { delay: 100 });
        }

        await page.click('.btn_login');

        // 로그인 완료 대기
        await page.waitForTimeout(3000);

        // 로그인 성공 여부 확인
        const currentUrl = page.url();
        this.logger.log(`로그인 후 URL: ${currentUrl}`);
      }

      // 블로그 관리자 통계 페이지로 이동 (새로운 URL 형식)
      const statsUrl = `https://admin.blog.naver.com/${blogId}/stat/today`;
      this.logger.log(`통계 페이지로 이동: ${statsUrl}`);

      await page.goto(statsUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForTimeout(3000);

      // 현재 페이지 URL 및 상태 로깅
      const finalUrl = page.url();
      this.logger.log(`현재 페이지 URL: ${finalUrl}`);

      // 통계 데이터 추출
      const stats: BlogStats = {
        totalPosts: 0,
        totalViews: 0,
        todayVisitors: 0,
      };

      // 오늘 방문자 수 셀렉터 (여러 패턴 시도)
      const todaySelectors = [
        '.today_area .num',
        '.stat_today .count',
        '.today_cnt',
        '.today .count',
        '.stat_num.today',
        '[class*="today"] .num',
        '[class*="today"] span',
        '.stat_box .today .num',
      ];

      for (const selector of todaySelectors) {
        const el = await page.$(selector).catch(() => null);
        if (el) {
          const text = await el.textContent();
          const parsed = this.parseNumber(text || '0');
          if (parsed > 0) {
            stats.todayVisitors = parsed;
            this.logger.log(`오늘 방문자 발견 (${selector}): ${parsed}`);
            break;
          }
        }
      }

      // 총 방문자 수 셀렉터 (여러 패턴 시도)
      const totalSelectors = [
        '.total_area .num',
        '.stat_total .count',
        '.total_cnt',
        '.total .count',
        '.stat_num.total',
        '[class*="total"] .num',
        '[class*="total"] span',
        '.stat_box .total .num',
      ];

      for (const selector of totalSelectors) {
        const el = await page.$(selector).catch(() => null);
        if (el) {
          const text = await el.textContent();
          const parsed = this.parseNumber(text || '0');
          if (parsed > 0) {
            stats.totalViews = parsed;
            this.logger.log(`총 조회수 발견 (${selector}): ${parsed}`);
            break;
          }
        }
      }

      // 통계를 찾지 못한 경우 페이지 HTML 디버깅
      if (stats.todayVisitors === 0 && stats.totalViews === 0) {
        this.logger.warn(
          '통계 데이터를 찾지 못했습니다. 페이지 구조를 확인합니다.',
        );

        // 페이지 내 모든 숫자 요소 검색
        const allNumbers = await page.evaluate(() => {
          const elements = document.querySelectorAll('span, div, p, strong');
          const results: string[] = [];
          elements.forEach((el) => {
            const text = el.textContent?.trim() || '';
            if (/^\d{1,3}(,\d{3})*$/.test(text) || /^\d+$/.test(text)) {
              results.push(el.className + ': ' + text);
            }
          });
          return results.slice(0, 20);
        });

        this.logger.log('페이지 내 숫자 요소들: ' + allNumbers.join(', '));

        // 디버깅용 스크린샷
        const screenshotPath = 'debug-naver-stats-' + Date.now() + '.png';
        await page
          .screenshot({ path: screenshotPath, fullPage: true })
          .catch(() => {});
        this.logger.log('디버깅 스크린샷 저장: ' + screenshotPath);
      }

      this.logger.log(
        `네이버 블로그 통계 수집 완료: 오늘 방문자 ${stats.todayVisitors}, 총 조회수 ${stats.totalViews}`,
      );
      return stats;
    } catch (error) {
      this.logger.error(`네이버 블로그 통계 크롤링 실패: ${error.message}`);
      this.logger.warn(
        '네이버 블로그 크롤링은 로그인 정보가 필요하며, 캡챠 또는 페이지 구조 변경 시 작동하지 않을 수 있습니다.',
      );
      return null;
    } finally {
      await page.close();
    }
  }

  /**
   * WordPress 통계 수집 (REST API 사용)
   *
   * WordPress REST API를 사용하여 게시물 및 통계 정보를 가져옵니다.
   * 일부 테마/플러그인은 추가 인증이 필요할 수 있습니다.
   */
  async crawlWordPressStats(
    connection: MediaConnection,
  ): Promise<BlogStats | null> {
    if (!connection.accountUrl) {
      this.logger.warn('WordPress 통계 수집: 블로그 URL이 없습니다.');
      return null;
    }

    try {
      this.logger.log(`WordPress 통계 수집 시작: ${connection.accountUrl}`);

      const baseUrl = connection.accountUrl.replace(/\/$/, '');

      // WordPress REST API 엔드포인트
      const postsApiUrl = `${baseUrl}/wp-json/wp/v2/posts?per_page=100`;

      // 게시물 목록 가져오기
      const response = await fetch(postsApiUrl);

      if (!response.ok) {
        this.logger.warn(
          `WordPress API 접근 실패: ${response.status} - ${response.statusText}`,
        );
        this.logger.warn(
          'WordPress REST API가 비활성화되어 있거나 접근 권한이 없습니다.',
        );
        return null;
      }

      const posts = await response.json();

      if (!Array.isArray(posts)) {
        this.logger.warn('WordPress API 응답이 올바르지 않습니다.');
        return null;
      }

      const stats: BlogStats = {
        totalPosts: posts.length,
        totalViews: 0, // WordPress 기본 API는 조회수를 제공하지 않음
        todayVisitors: 0, // WordPress 기본 API는 방문자를 제공하지 않음
      };

      // Jetpack Stats API 시도 (선택적)
      if (connection.username && connection.password) {
        try {
          const statsUrl = `${baseUrl}/wp-json/jetpack/v4/stats`;
          const statsResponse = await fetch(statsUrl, {
            headers: {
              Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}`,
            },
          });

          if (statsResponse.ok) {
            const jetpackStats = await statsResponse.json();
            if (jetpackStats.stats) {
              stats.totalViews = jetpackStats.stats.views || 0;
              stats.todayVisitors = jetpackStats.stats.visitors_today || 0;
            }
          }
        } catch (error) {
          // Jetpack이 없으면 무시
          this.logger.debug(`Jetpack Stats API 사용 불가: ${error.message}`);
        }
      }

      this.logger.log(
        `WordPress 통계 수집 완료: 총 게시물 ${stats.totalPosts}, 조회수 ${stats.totalViews}`,
      );
      return stats;
    } catch (error) {
      this.logger.error(`WordPress 통계 수집 실패: ${error.message}`);
      return null;
    }
  }

  /**
   * LinkedIn 통계 수집 (API 사용)
   *
   * LinkedIn API를 사용하여 게시물 통계를 가져옵니다.
   * OAuth 인증된 액세스 토큰이 필요합니다.
   */
  async crawlLinkedInStats(
    connection: MediaConnection,
  ): Promise<BlogStats | null> {
    if (!connection.accessToken) {
      this.logger.warn(
        'LinkedIn 통계 수집: 액세스 토큰이 없습니다. OAuth 인증을 먼저 진행해주세요.',
      );
      return null;
    }

    try {
      this.logger.log(`LinkedIn 통계 수집 시작: ${connection.accountUrl}`);

      // LinkedIn API를 사용하여 사용자 ID 가져오기
      const userInfoResponse = await fetch(
        'https://api.linkedin.com/v2/userinfo',
        {
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
          },
        },
      );

      if (!userInfoResponse.ok) {
        this.logger.warn(`LinkedIn API 접근 실패: ${userInfoResponse.status}`);
        this.logger.warn(
          '액세스 토큰이 만료되었거나 권한이 없습니다. OAuth 재인증이 필요합니다.',
        );
        return null;
      }

      const userInfo = await userInfoResponse.json();
      const userId = userInfo.sub;

      // LinkedIn API v2를 사용하여 게시물 목록 가져오기
      // 참고: LinkedIn API는 게시물 통계에 제한이 있을 수 있음
      const postsResponse = await fetch(
        `https://api.linkedin.com/v2/ugcPosts?q=authors&authors=List(urn:li:person:${userId})&count=50`,
        {
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
          },
        },
      );

      if (!postsResponse.ok) {
        this.logger.warn(`LinkedIn 게시물 조회 실패: ${postsResponse.status}`);
        return null;
      }

      const postsData = await postsResponse.json();
      const posts = postsData.elements || [];

      // 통계 집계
      let totalViews = 0;
      let totalEngagements = 0;

      for (const post of posts) {
        // LinkedIn API는 게시물별 통계를 별도로 조회해야 함
        // 간단한 통계만 수집 (상세 통계는 별도 API 호출 필요)
        if (post.statistics) {
          totalViews += post.statistics.numViews || 0;
          totalEngagements +=
            (post.statistics.numLikes || 0) +
            (post.statistics.numComments || 0);
        }
      }

      const stats: BlogStats = {
        totalPosts: posts.length,
        totalViews: totalViews,
        todayVisitors: 0, // LinkedIn API는 일별 방문자를 제공하지 않음
      };

      this.logger.log(
        `LinkedIn 통계 수집 완료: 게시물 ${stats.totalPosts}, 조회수 ${stats.totalViews}`,
      );
      return stats;
    } catch (error) {
      this.logger.error(`LinkedIn 통계 수집 실패: ${error.message}`);
      return null;
    }
  }

  /**
   * 티스토리 통계 크롤링 (로그인 필요)
   *
   * ⚠️ 주의: 웹 크롤링은 불안정하며, 다음과 같은 문제가 발생할 수 있습니다:
   * - 로그인 페이지 구조 변경
   * - CAPTCHA 또는 보안 인증 요구
   * - 네트워크 지연 또는 타임아웃
   *
   * 권장: API가 있는 매체는 API를 사용하세요.
   */
  async crawlTistoryStats(
    connection: MediaConnection,
  ): Promise<BlogStats | null> {
    if (!connection.username || !connection.password) {
      this.logger.warn(
        '티스토리 크롤링: 인증 정보 없음. 매체 연동 설정에서 로그인 정보를 입력해주세요.',
      );
      return null;
    }

    const browser = await this.getBrowser();
    const page = await browser.newPage();

    // 타임아웃 설정 증가
    page.setDefaultTimeout(60000); // 60초

    try {
      this.logger.log(`티스토리 통계 수집 시작: ${connection.accountUrl}`);

      // 티스토리 로그인 페이지
      await page.goto('https://www.tistory.com/auth/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await page.waitForTimeout(2000);

      // 카카오 계정으로 로그인 (일반적인 경우)
      const kakaoLoginBtn = await page
        .waitForSelector('.btn_login_kakao, .link_kakao_id', {
          timeout: 5000,
          state: 'visible',
        })
        .catch(() => null);

      if (!kakaoLoginBtn) {
        this.logger.warn(
          '티스토리 크롤링: 카카오 로그인 버튼을 찾을 수 없습니다. 페이지 구조가 변경되었을 수 있습니다.',
        );
        // 스크린샷 저장 (디버깅용)
        await page
          .screenshot({ path: `debug-tistory-login-${Date.now()}.png` })
          .catch(() => {});
        return null;
      }

      this.logger.log('카카오 로그인 버튼 클릭');
      await kakaoLoginBtn.click();

      // 카카오 로그인 페이지 로딩 대기
      await page.waitForTimeout(5000);

      // 현재 URL 확인
      const currentUrl = page.url();
      this.logger.log(`현재 페이지: ${currentUrl}`);

      // 카카오 로그인 폼 (여러 셀렉터 시도)
      const loginSelectors = [
        '#loginId',
        '#id_email_2',
        'input[name="email"]',
        'input[type="text"][placeholder*="카카오"]',
        'input[type="text"][placeholder*="이메일"]',
        'input.tf_g',
        '#email',
      ];

      let loginIdInput = null;
      let usedSelector = '';

      for (const selector of loginSelectors) {
        loginIdInput = await page
          .waitForSelector(selector, { timeout: 3000, state: 'visible' })
          .catch(() => null);
        if (loginIdInput) {
          usedSelector = selector;
          this.logger.log(`카카오 로그인 폼 발견: ${selector}`);
          break;
        }
      }

      if (!loginIdInput) {
        this.logger.warn(
          '티스토리 크롤링: 카카오 로그인 폼을 찾을 수 없습니다.',
        );
        this.logger.log(`현재 URL: ${page.url()}`);
        // HTML 구조 출력 (디버깅용)
        const bodyHTML = await page
          .evaluate(() => document.body.innerHTML)
          .catch(() => '');
        this.logger.debug(
          `페이지 HTML (앞 500자): ${bodyHTML.substring(0, 500)}`,
        );
        // 스크린샷 저장 (디버깅용)
        await page
          .screenshot({ path: `debug-kakao-login-${Date.now()}.png` })
          .catch(() => {});
        return null;
      }

      this.logger.log('카카오 로그인 폼 발견, 로그인 시도');

      // 비밀번호 셀렉터
      const passwordSelectors = [
        '#password',
        '#id_password_3',
        'input[name="password"]',
        'input[type="password"]',
        'input.tf_g[type="password"]',
      ];

      let passwordInput = null;
      for (const selector of passwordSelectors) {
        passwordInput = await page.$(selector);
        if (passwordInput) {
          break;
        }
      }

      if (!passwordInput) {
        this.logger.warn(
          '티스토리 크롤링: 비밀번호 입력 필드를 찾을 수 없습니다.',
        );
        return null;
      }

      // 로그인 정보 입력
      await loginIdInput.fill(connection.username);
      await passwordInput.fill(connection.password);

      // 로그인 버튼 클릭
      const submitSelectors = [
        '.btn_confirm',
        '.submit',
        'button[type="submit"]',
        '.btn_g.highlight',
        'button.btn_g',
      ];

      let submitted = false;
      for (const selector of submitSelectors) {
        const submitBtn = await page.$(selector);
        if (submitBtn) {
          await submitBtn.click();
          submitted = true;
          this.logger.log(`로그인 버튼 클릭: ${selector}`);
          break;
        }
      }

      if (!submitted) {
        this.logger.warn('티스토리 크롤링: 로그인 버튼을 찾을 수 없습니다.');
        return null;
      }

      // 로그인 완료 대기
      await page.waitForTimeout(5000);

      this.logger.log('로그인 완료, 통계 페이지로 이동');

      // 관리자 페이지로 이동
      // 블로그 주소 추출 필요 - accountUrl 사용
      if (connection.accountUrl) {
        const blogName = this.extractTistoryBlogName(connection.accountUrl);
        if (blogName) {
          await page.goto(`https://${blogName}.tistory.com/manage/statistics`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          });
        } else {
          this.logger.warn(
            `티스토리 블로그 이름 추출 실패: ${connection.accountUrl}`,
          );
          return null;
        }
      } else {
        await page.goto('https://www.tistory.com/manage/statistics', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }

      await page.waitForTimeout(2000);

      const stats: BlogStats = {
        totalPosts: 0,
        totalViews: 0,
        todayVisitors: 0,
      };

      // 통계 데이터 추출
      const todayEl = await page
        .$('.today_count, .count_today')
        .catch(() => null);
      if (todayEl) {
        const text = await todayEl.textContent();
        stats.todayVisitors = this.parseNumber(text || '0');
      }

      const totalEl = await page
        .$('.total_count, .count_total')
        .catch(() => null);
      if (totalEl) {
        const text = await totalEl.textContent();
        stats.totalViews = this.parseNumber(text || '0');
      }

      this.logger.log(
        `티스토리 통계 수집 완료: 오늘 방문자 ${stats.todayVisitors}, 총 조회수 ${stats.totalViews}`,
      );
      return stats;
    } catch (error) {
      this.logger.error(`티스토리 통계 크롤링 실패: ${error.message}`);
      this.logger.warn(
        '티스토리 크롤링은 로그인 정보가 필요하며, 페이지 구조 변경 시 작동하지 않을 수 있습니다.',
      );
      return null;
    } finally {
      await page.close();
    }
  }

  /**
   * 프로젝트의 모든 키워드 순위 업데이트
   */
  async updateProjectKeywordRankings(projectId: string): Promise<void> {
    const keywords = await this.keywordRankingRepository.find({
      where: { projectId, isActive: true },
    });

    for (const keyword of keywords) {
      try {
        if (keyword.searchEngine === SearchEngine.NAVER) {
          const { targetRank } = await this.crawlNaverSearchRanking(
            keyword.keyword,
            keyword.targetUrl,
          );
          await this.analyticsService.updateKeywordRank(keyword.id, targetRank);
        }
        // Google 크롤링은 별도 구현 필요 (API 사용 권장)

        // 크롤링 간 딜레이 (rate limiting 방지)
        await this.delay(2000);
      } catch (error) {
        this.logger.error(
          `키워드 "${keyword.keyword}" 순위 업데이트 실패: ${error.message}`,
        );
      }
    }
  }

  /**
   * 프로젝트의 모든 매체 통계 업데이트
   */
  async updateProjectMediaStats(
    projectId: string,
    userId: string,
  ): Promise<void> {
    const connections = await this.mediaConnectionRepository.find({
      where: { projectId, userId },
    });

    for (const connection of connections) {
      try {
        let stats: BlogStats | null = null;

        switch (connection.platform) {
          case MediaPlatform.NAVER_BLOG:
            stats = await this.crawlNaverBlogStats(connection);
            break;
          case MediaPlatform.TISTORY:
            stats = await this.crawlTistoryStats(connection);
            break;
          case MediaPlatform.WORDPRESS:
            stats = await this.crawlWordPressStats(connection);
            break;
          case MediaPlatform.LINKEDIN:
            stats = await this.crawlLinkedInStats(connection);
            break;
          // X, Facebook, Instagram 등은 별도 API 구현 필요
        }

        if (stats) {
          // 트래픽 스냅샷 저장
          await this.analyticsService.saveTrafficSnapshot(
            projectId,
            userId,
            connection.platform,
            {
              visitors: stats.todayVisitors,
              pageViews: stats.todayVisitors, // 상세 데이터 없으면 방문자로 대체
            },
          );

          // MediaAnalytics 업데이트 또는 생성
          let analytics = await this.mediaAnalyticsRepository.findOne({
            where: { projectId, platform: connection.platform },
          });

          if (!analytics) {
            // 처음 수집하는 경우 새로 생성
            this.logger.log(`${connection.platform} MediaAnalytics 생성 중...`);
            analytics = this.mediaAnalyticsRepository.create({
              projectId,
              userId,
              platform: connection.platform,
              domainAuthority: 0,
              pageAuthority: 0,
              totalBacklinks: 0,
              indexedPages: 0,
              spamScore: 0,
              totalPosts: 0,
              totalViews: 0,
              avgViews: 0,
              engagementRate: 0,
            });
          }

          // 통계 업데이트
          analytics.totalPosts = stats.totalPosts;
          analytics.totalViews = stats.totalViews;

          // 평균 조회수 계산
          if (analytics.totalPosts > 0) {
            analytics.avgViews = analytics.totalViews / analytics.totalPosts;
          }

          analytics.lastDataCollectedAt = new Date();

          await this.mediaAnalyticsRepository.save(analytics);

          this.logger.log(
            `${connection.platform} 통계 업데이트 완료 - 게시물: ${stats.totalPosts}, 총 조회: ${stats.totalViews}, 오늘: ${stats.todayVisitors}`,
          );
        } else {
          // 데이터 수집 실패 또는 인증 정보 없음
          this.logger.warn(
            `${connection.platform} 통계 수집 실패 - 인증 정보 확인 또는 API 접근 권한을 확인해주세요.`,
          );

          // 기본 MediaAnalytics가 없으면 생성 (0으로 초기화)
          let analytics = await this.mediaAnalyticsRepository.findOne({
            where: { projectId, platform: connection.platform },
          });

          if (!analytics) {
            this.logger.log(
              `${connection.platform} 기본 MediaAnalytics 생성 중...`,
            );
            analytics = this.mediaAnalyticsRepository.create({
              projectId,
              userId,
              platform: connection.platform,
              domainAuthority: 0,
              pageAuthority: 0,
              totalBacklinks: 0,
              indexedPages: 0,
              spamScore: 0,
              totalPosts: 0,
              totalViews: 0,
              avgViews: 0,
              engagementRate: 0,
            });
            await this.mediaAnalyticsRepository.save(analytics);
            this.logger.log(
              `${connection.platform} 기본 MediaAnalytics 생성 완료 (데이터 수집 필요)`,
            );
          }
        }

        await this.delay(3000);
      } catch (error) {
        this.logger.error(
          `${connection.platform} 통계 업데이트 실패: ${error.message}`,
        );
      }
    }
  }

  /**
   * URL 정규화
   */
  private normalizeUrl(url: string): string {
    return url
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '')
      .toLowerCase();
  }

  /**
   * 숫자 파싱 (콤마 제거 등)
   */
  private parseNumber(text: string): number {
    return parseInt(text.replace(/[^\d]/g, ''), 10) || 0;
  }

  /**
   * 티스토리 블로그 이름 추출
   */
  private extractTistoryBlogName(url: string): string {
    const match = url.match(/https?:\/\/([^.]+)\.tistory\.com/);
    return match ? match[1] : '';
  }

  /**
   * 네이버 블로그 ID 추출
   * @example https://blog.naver.com/re-rank → re-rank
   * @example https://m.blog.naver.com/re-rank → re-rank
   */
  private extractNaverBlogId(url: string): string {
    // https://blog.naver.com/blogId 형식
    const match = url.match(/https?:\/\/(?:m\.)?blog\.naver\.com\/([^\/\?]+)/);
    return match ? match[1] : '';
  }

  /**
   * 딜레이 유틸리티
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Browser, BrowserContext, Page, Frame } from 'playwright-core';

import {
  AuthoritySite,
  SiteType,
} from '../database/entities/authority-site.entity';
import {
  BacklinkPost,
  PostStatus,
} from '../database/entities/backlink-post.entity';
import { CreateAuthoritySiteDto } from './dto/create-authority-site.dto';
import { UpdateAuthoritySiteDto } from './dto/update-authority-site.dto';

@Injectable()
export class BacklinkSitesService {
  private readonly logger = new Logger(BacklinkSitesService.name);

  constructor(
    @InjectRepository(AuthoritySite)
    private readonly siteRepository: Repository<AuthoritySite>,
    @InjectRepository(BacklinkPost)
    private readonly postRepository: Repository<BacklinkPost>,
  ) {}

  // ── CRUD ──

  async findAll(userId: string): Promise<AuthoritySite[]> {
    return this.siteRepository.find({
      where: { userId },
      order: { priority: 'DESC', createdAt: 'DESC' },
    });
  }

  async create(
    userId: string,
    dto: CreateAuthoritySiteDto,
  ): Promise<AuthoritySite> {
    const site = this.siteRepository.create({ ...dto, userId });
    return this.siteRepository.save(site);
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateAuthoritySiteDto,
  ): Promise<AuthoritySite> {
    const site = await this.siteRepository.findOne({ where: { id, userId } });
    if (!site) throw new NotFoundException('사이트를 찾을 수 없습니다.');
    Object.assign(site, dto);
    return this.siteRepository.save(site);
  }

  async remove(id: string, userId: string): Promise<void> {
    const site = await this.siteRepository.findOne({ where: { id, userId } });
    if (!site) throw new NotFoundException('사이트를 찾을 수 없습니다.');
    await this.siteRepository.remove(site);
  }

  // ── 글 등록 이력 ──

  async findPosts(userId: string): Promise<BacklinkPost[]> {
    return this.postRepository.find({
      where: { userId },
      relations: ['authoritySite'],
      order: { createdAt: 'DESC' },
    });
  }

  // ── Playwright 글 등록 ──

  async publishToSites(
    userId: string,
    siteIds: string[],
    title: string,
    body: string,
  ): Promise<BacklinkPost[]> {
    const sites = await this.siteRepository.find({
      where: { id: In(siteIds), userId },
    });

    if (sites.length === 0) {
      throw new NotFoundException('선택된 사이트를 찾을 수 없습니다.');
    }

    // 타입별 그룹핑: API 기반(WP)은 즉시 병렬, 티스토리는 동시 2개씩, 나머지 순차
    const wpSites = sites.filter(
      (s) => s.siteType === SiteType.WORDPRESS && s.wordpressApiUrl,
    );
    const tistorySites = sites.filter(
      (s) => s.siteType === SiteType.TISTORY,
    );
    const otherSites = sites.filter(
      (s) =>
        !(s.siteType === SiteType.WORDPRESS && s.wordpressApiUrl) &&
        s.siteType !== SiteType.TISTORY,
    );

    const allResults: BacklinkPost[] = [];

    // 1) WordPress – 전부 즉시 병렬 (API 호출, 딜레이 불필요)
    if (wpSites.length > 0) {
      this.logger.log(
        `WordPress ${wpSites.length}개 사이트 병렬 발행 시작`,
      );
      const wpPromises = wpSites.map((site) =>
        this.publishAndSave(site, title, body, userId),
      );
      allResults.push(...(await Promise.all(wpPromises)));
    }

    // 2) 기타 (LinkedIn 등) – 병렬 발행
    if (otherSites.length > 0) {
      this.logger.log(
        `기타 ${otherSites.length}개 사이트 병렬 발행 시작`,
      );
      const otherPromises = otherSites.map((site) =>
        this.publishAndSave(site, title, body, userId),
      );
      allResults.push(...(await Promise.all(otherPromises)));
    }

    // 3) 티스토리 – 동시 2개씩 (브라우저 리소스 제한 + CAPTCHA 방지)
    if (tistorySites.length > 0) {
      this.logger.log(
        `티스토리 ${tistorySites.length}개 사이트 발행 시작 (동시 2개)`,
      );
      const TISTORY_CONCURRENCY = 2;
      for (let i = 0; i < tistorySites.length; i += TISTORY_CONCURRENCY) {
        if (i > 0) {
          const delay = 10000 + Math.random() * 10000;
          this.logger.log(
            `다음 티스토리 배치까지 ${Math.round(delay / 1000)}초 대기`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const batch = tistorySites.slice(i, i + TISTORY_CONCURRENCY);
        const batchPromises = batch.map((site) =>
          this.publishAndSave(site, title, body, userId),
        );
        allResults.push(...(await Promise.all(batchPromises)));
      }
    }

    return allResults;
  }

  /** 단일 사이트 발행 + DB 저장 (병렬 호출용 헬퍼) */
  private async publishAndSave(
    site: AuthoritySite,
    title: string,
    body: string,
    userId: string,
  ): Promise<BacklinkPost> {
    const post = this.postRepository.create({
      authoritySiteId: site.id,
      title,
      body,
      status: PostStatus.PENDING,
      userId,
    });

    try {
      const result = await this.publishToSingleSite(site, title, body);
      post.status = result.success ? PostStatus.SUCCESS : PostStatus.FAILED;
      post.publishedUrl = result.publishedUrl ?? undefined;
      post.errorMessage = result.error ?? undefined;
    } catch (err) {
      post.status = PostStatus.FAILED;
      post.errorMessage = err instanceof Error ? err.message : String(err);
    }

    return this.postRepository.save(post);
  }

  private async publishToSingleSite(
    site: AuthoritySite,
    title: string,
    body: string,
  ): Promise<{ success: boolean; publishedUrl?: string; error?: string }> {
    if (site.siteType === SiteType.WORDPRESS && site.wordpressApiUrl) {
      return this.publishViaWordPressApi(site, title, body);
    }
    if (site.siteType === SiteType.TISTORY) {
      return this.publishViaTistory(site, title, body);
    }
    if (site.siteType === SiteType.LINKEDIN) {
      return this.publishViaPlaywright(site, title, body);
    }
    // CUSTOM (레거시) 또는 알 수 없는 타입
    return this.publishViaPlaywright(site, title, body);
  }

  // ── WordPress REST API 방식 ──

  private async publishViaWordPressApi(
    site: AuthoritySite,
    title: string,
    body: string,
  ): Promise<{ success: boolean; publishedUrl?: string; error?: string }> {
    try {
      const auth = Buffer.from(
        `${site.wordpressUsername}:${site.wordpressAppPassword}`,
      ).toString('base64');

      // wordpressApiUrl이 /wp/v2로 끝나는 경우 /posts만 추가, 아니면 /wp/v2/posts 추가
      const wpApiBase = site.wordpressApiUrl.replace(/\/+$/, '');
      const postsUrl = wpApiBase.endsWith('/wp/v2')
        ? `${wpApiBase}/posts`
        : `${wpApiBase}/wp/v2/posts`;

      const response = await fetch(postsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({ title, content: body, status: 'publish' }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          success: false,
          error: `WordPress API 오류: ${response.status} ${errText}`,
        };
      }

      const data = await response.json();
      return { success: true, publishedUrl: data.link };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Playwright 범용 글 등록 ──

  private async publishViaPlaywright(
    site: AuthoritySite,
    title: string,
    body: string,
  ): Promise<{ success: boolean; publishedUrl?: string; error?: string }> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      browser = await this.createBrowser();
      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
      });

      // 1. 세션 쿠키 복원
      if (site.sessionCookies) {
        const cookieArray = this.parseCookieString(
          site.sessionCookies,
          new URL(site.siteUrl).hostname,
        );
        await context.addCookies(cookieArray);
      }

      const page = await context.newPage();

      // 2. 로그인 필요시 로그인
      if (site.loginUrl && site.loginUsername && site.loginPassword) {
        await page.goto(site.loginUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(2000);

        if (site.loginUsernameSelector) {
          await page.fill(site.loginUsernameSelector, site.loginUsername);
        }
        if (site.loginPasswordSelector) {
          await page.fill(site.loginPasswordSelector, site.loginPassword);
        }
        if (site.loginSubmitSelector) {
          await page.click(site.loginSubmitSelector);
          await page.waitForTimeout(3000);
        }

        // 로그인 후 쿠키 저장
        const cookies = await context.cookies();
        const updatedCookies = JSON.stringify(cookies);
        await this.siteRepository.update(site.id, {
          sessionCookies: updatedCookies,
        });
      }

      // 3. 글쓰기 페이지 이동
      if (!site.writeUrl) {
        return { success: false, error: '글쓰기 URL이 설정되지 않았습니다.' };
      }

      await page.goto(site.writeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // 4. 제목 입력
      if (site.titleSelector) {
        const titleEl = await page.$(site.titleSelector);
        if (titleEl) {
          const tagName = await titleEl.evaluate((el) =>
            el.tagName.toLowerCase(),
          );
          if (tagName === 'input' || tagName === 'textarea') {
            await titleEl.fill(title);
          } else {
            // contenteditable 등
            await titleEl.click();
            await page.keyboard.type(title);
          }
        } else {
          return {
            success: false,
            error: `제목 셀렉터를 찾을 수 없음: ${site.titleSelector}`,
          };
        }
      }

      // 5. 본문 입력
      if (site.bodySelector) {
        const bodyEl = await page.$(site.bodySelector);
        if (bodyEl) {
          const tagName = await bodyEl.evaluate((el) =>
            el.tagName.toLowerCase(),
          );
          if (tagName === 'textarea') {
            await bodyEl.fill(body);
          } else if (tagName === 'iframe') {
            // iframe 기반 에디터
            const frame = await bodyEl.contentFrame();
            if (frame) {
              const frameBody = await frame.$('body');
              if (frameBody) {
                await frameBody.click();
                await frame.evaluate((html) => {
                  document.body.innerHTML = html;
                }, body);
              }
            }
          } else {
            // contenteditable div 등
            await bodyEl.click();
            await bodyEl.evaluate((el, html) => {
              (el as HTMLElement).innerHTML = html;
            }, body);
          }
        } else {
          return {
            success: false,
            error: `본문 셀렉터를 찾을 수 없음: ${site.bodySelector}`,
          };
        }
      }

      // 6. 등록 버튼 클릭
      if (site.submitSelector) {
        await page.waitForTimeout(1000);
        await page.click(site.submitSelector);
        await page.waitForTimeout(5000);
      }

      // 7. 등록 후 URL 수집 및 검증
      const currentUrl = page.url();

      // 글쓰기 페이지에 그대로 머물러 있으면 실패로 판단
      if (site.writeUrl && currentUrl === site.writeUrl) {
        return {
          success: false,
          error: `등록 후에도 글쓰기 페이지에 머물러 있습니다. 실제 등록이 이루어지지 않았을 수 있습니다. (URL: ${currentUrl})`,
        };
      }

      return { success: true, publishedUrl: currentUrl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Playwright 발행 실패 [${site.siteName}] writeUrl=${site.writeUrl}: ${msg}`,
      );
      return { success: false, error: msg };
    } finally {
      try {
        await context?.close();
      } catch {
        /* ignore */
      }
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // ── 티스토리 Playwright 글 등록 ──

  private async publishViaTistory(
    site: AuthoritySite,
    title: string,
    body: string,
  ): Promise<{ success: boolean; publishedUrl?: string; error?: string }> {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      // 티스토리는 데이터센터 IP에서 dkaptcha CAPTCHA가 발생하므로 한국 프록시 사용
      browser = await this.createBrowser({ useResidentialProxy: true });
      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
        ignoreHTTPSErrors: true,
      });

      // 1. 세션 쿠키 복원
      if (site.sessionCookies) {
        try {
          const cookies = JSON.parse(site.sessionCookies);
          await context.addCookies(cookies);
        } catch {
          this.logger.warn('티스토리 세션 쿠키 파싱 실패');
        }
      }

      const page = await context.newPage();

      // 브라우저 콘솔 로그 수집 (에러/경고만)
      page.on('console', (msg) => {
        const type = msg.type();
        if (type === 'error' || type === 'warning') {
          this.logger.warn(
            `[브라우저 ${type}] ${msg.text().substring(0, 200)}`,
          );
        }
      });

      // 페이지 에러(크래시) 감지
      page.on('pageerror', (err) => {
        this.logger.error(`[페이지 에러] ${err.message.substring(0, 200)}`);
      });

      // 다이얼로그(confirm/alert) 자동 수락 – 임시저장 복구 팝업 등 차단 방지
      page.on('dialog', async (dialog) => {
        this.logger.log(
          `다이얼로그 감지: ${dialog.type()} - ${dialog.message()}`,
        );
        await dialog.accept();
      });

      // 2. 세션 워밍업 (쿠키가 있으면 축소, 없으면 전체)
      const blogName =
        (site.siteUrl.match(/https?:\/\/([^.]+)\.tistory\.com/) || [])[1] || '';
      const hasSession = !!site.sessionCookies;

      if (hasSession) {
        // 쿠키가 있으면 블로그 홈만 간단히 방문 (워밍업 축소)
        this.logger.log(`세션 쿠키 있음 – 간소화 워밍업 (blog: ${blogName})`);
        if (blogName) {
          try {
            await page.goto(`https://${blogName}.tistory.com/`, {
              waitUntil: 'domcontentloaded',
              timeout: 15000,
            });
            await page.waitForTimeout(1000 + Math.floor(Math.random() * 1000));
          } catch {
            /* ignore */
          }
        }
      } else {
        // 쿠키 없으면 전체 워밍업
        this.logger.log(`세션 쿠키 없음 – 전체 워밍업 시작 (blog: ${blogName})`);
        try {
          await page.goto('https://www.tistory.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });
          await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
          await page.evaluate(() =>
            window.scrollBy(0, 200 + Math.random() * 300),
          );
          await page.waitForTimeout(500 + Math.floor(Math.random() * 500));
        } catch {
          /* ignore */
        }

        if (blogName) {
          try {
            await page.goto(`https://${blogName}.tistory.com/`, {
              waitUntil: 'domcontentloaded',
              timeout: 15000,
            });
            await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
            await page.evaluate(() =>
              window.scrollBy(0, 300 + Math.random() * 400),
            );
            await page.waitForTimeout(500 + Math.floor(Math.random() * 500));
          } catch {
            /* ignore */
          }

          try {
            await page.goto(`https://${blogName}.tistory.com/manage/`, {
              waitUntil: 'domcontentloaded',
              timeout: 15000,
            });
            await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
          } catch {
            /* ignore */
          }
        }
      }
      this.logger.log('세션 워밍업 완료');

      // 3. 글쓰기 페이지 이동 (리다이렉트 가능하므로 에러 허용)
      const writeUrl =
        site.writeUrl || `${site.siteUrl.replace(/\/$/, '')}/manage/newpost`;
      try {
        await page.goto(writeUrl, {
          waitUntil: 'load',
          timeout: 45000,
        });
      } catch (navErr) {
        // 리다이렉트로 인한 "interrupted by another navigation" 에러는 무시
        this.logger.warn(
          `글쓰기 페이지 이동 중 에러 (리다이렉트 가능): ${navErr instanceof Error ? navErr.message.substring(0, 100) : String(navErr)}`,
        );
      }

      // SPA JS 번들 완전 로드 대기
      try {
        await page.waitForLoadState('networkidle', { timeout: 20000 });
        this.logger.log('networkidle 상태 도달');
      } catch {
        this.logger.warn('networkidle 대기 타임아웃 (20초) – 계속 진행');
      }

      // 3-1. 로그인 필요 여부 확인
      const currentUrl = page.url();
      this.logger.log(`글쓰기 페이지 이동 후 URL: ${currentUrl}`);
      const needsLogin =
        currentUrl.includes('accounts.kakao.com') ||
        currentUrl.includes('tistory.com/auth/login') ||
        (!currentUrl.includes('/manage/newpost') &&
          !currentUrl.includes('/manage/edit'));

      if (needsLogin) {
        this.logger.log('로그인 필요 – 카카오 로그인 시도');
        if (!site.loginUsername || !site.loginPassword) {
          return {
            success: false,
            error: `카카오 로그인 정보가 설정되지 않았습니다. (현재 URL: ${currentUrl})`,
          };
        }

        // /manage/ 페이지나 기타 페이지인 경우 → 티스토리 로그인 페이지로 직접 이동
        if (
          !currentUrl.includes('accounts.kakao.com') &&
          !currentUrl.includes('tistory.com/auth/login')
        ) {
          this.logger.log('티스토리 로그인 페이지로 직접 이동');
          await page.goto('https://www.tistory.com/auth/login', {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });
          await page.waitForTimeout(2000);
        }

        // 티스토리 로그인 페이지인 경우 카카오 로그인 버튼 클릭
        const loginPageUrl = page.url();
        if (loginPageUrl.includes('tistory.com/auth/login')) {
          const kakaoBtn = await page.$('.btn_login.link_kakao_id');
          if (kakaoBtn) {
            await kakaoBtn.click();
            await page.waitForTimeout(3000);
          } else {
            this.logger.warn('카카오 로그인 버튼을 찾지 못함');
          }
        }

        // 카카오 로그인 폼
        this.logger.log(`카카오 로그인 폼 URL: ${page.url()}`);
        const emailInput = await page.$(
          'input[name="loginId"], input[name="loginKey"], #loginId--1',
        );
        if (emailInput) {
          await emailInput.click();
          await emailInput.fill(site.loginUsername);
        } else {
          this.logger.warn('카카오 이메일 입력 필드를 찾지 못함');
        }

        const pwInput = await page.$('input[name="password"], #password--2');
        if (pwInput) {
          await pwInput.click();
          await pwInput.fill(site.loginPassword);
        } else {
          this.logger.warn('카카오 비밀번호 입력 필드를 찾지 못함');
        }

        // 로그인 버튼 클릭
        const loginBtn = await page.$(
          'button[type="submit"], .btn_g.btn_confirm.submit',
        );
        if (loginBtn) {
          await loginBtn.click();
          await page.waitForTimeout(5000);
          this.logger.log(`로그인 후 URL: ${page.url()}`);
        } else {
          this.logger.warn('로그인 버튼을 찾지 못함');
        }

        // 로그인 후 쿠키 저장
        const cookies = await context.cookies();
        await this.siteRepository.update(site.id, {
          sessionCookies: JSON.stringify(cookies),
        });

        // 글쓰기 페이지로 다시 이동
        const afterLoginUrl = page.url();
        if (!afterLoginUrl.includes('/manage/newpost')) {
          await page.goto(writeUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await page.waitForTimeout(3000);
        }
      }

      // 4. 제목 입력 - 티스토리 에디터 (SPA 렌더링 대기)
      const preTitleUrl = page.url();
      this.logger.log(`제목 입력 시도 – URL: ${preTitleUrl}`);

      // SPA가 완전히 렌더링될 때까지 대기 (최대 30초)
      const titleSelectors = [
        '#post-title-inp',
        'input[name="title"]',
        '.tit_post input',
        'input[placeholder*="제목"]',
      ];

      let titleInput = null;
      try {
        await page.waitForSelector(titleSelectors.join(', '), {
          timeout: 30000,
        });
      } catch {
        this.logger.warn('제목 필드 대기 타임아웃 (30초)');
      }

      for (const sel of titleSelectors) {
        titleInput = await page.$(sel);
        if (titleInput) {
          this.logger.log(`제목 필드 발견: ${sel}`);
          break;
        }
      }
      if (titleInput) {
        await titleInput.click();
        await titleInput.fill(title);
        this.logger.log('제목 입력 완료');
      } else {
        // 상세 페이지 상태 진단
        const diagInfo = await page.evaluate(() => {
          const inputs = document.querySelectorAll('input');
          const inputList = Array.from(inputs).map(
            (i) => `${i.type}:${i.name || i.id || i.placeholder || 'no-id'}`,
          );
          const scripts = document.querySelectorAll('script');
          const bodyLen = document.body?.innerHTML?.length || 0;
          const bodyText = document.body?.innerText?.substring(0, 300) || '';
          const readyState = document.readyState;
          const reactRoot = document.querySelector(
            '#root, #__next, [data-reactroot]',
          );
          const allElCount = document.querySelectorAll('*').length;
          return [
            `URL: ${location.href}`,
            `readyState: ${readyState}`,
            `title: "${document.title}"`,
            `scripts: ${scripts.length}`,
            `bodyHTML길이: ${bodyLen}`,
            `전체요소수: ${allElCount}`,
            `inputs: [${inputList.slice(0, 10).join(', ')}]`,
            `reactRoot: ${reactRoot ? reactRoot.tagName + '#' + reactRoot.id : 'none'}`,
            `bodyText: "${bodyText.replace(/\n/g, ' ').substring(0, 200)}"`,
          ].join(' | ');
        });
        this.logger.error(`제목 필드 미발견. 진단: ${diagInfo}`);
        return {
          success: false,
          error: `티스토리 제목 입력 필드를 찾을 수 없습니다. (${diagInfo})`,
        };
      }

      await page.waitForTimeout(1000);

      // 5. 본문 입력 - 티스토리 에디터
      let bodyInserted = false;

      // 방법 0: CKEditor API 사용 (가장 확실한 방법 - 에디터 내부 상태에 직접 반영)
      if (!bodyInserted) {
        bodyInserted = await page.evaluate((html) => {
          try {
            const ck = (window as any).CKEDITOR;
            if (ck && ck.instances) {
              const keys = Object.keys(ck.instances);
              if (keys.length > 0) {
                ck.instances[keys[0]].setData(html);
                return true;
              }
            }
          } catch {
            /* ignore */
          }
          return false;
        }, body);
        if (bodyInserted) {
          this.logger.log('CKEditor API로 본문 삽입 성공');
        }
      }

      // 방법 1: iframe 기반 에디터 + CKEditor 동기화
      if (!bodyInserted) {
        const iframeSelectors = [
          'iframe#editor-tistory',
          'iframe.editor',
          '#cke_contents iframe',
          '.editor-content iframe',
          'iframe',
        ];
        for (const sel of iframeSelectors) {
          const iframe = await page.$(sel);
          if (iframe) {
            const frame = await iframe.contentFrame();
            if (frame) {
              const frameBody = await frame.$('body');
              if (frameBody) {
                const isEditable = await frameBody.evaluate(
                  (el) => el.contentEditable === 'true' || el.isContentEditable,
                );
                if (isEditable || sel !== 'iframe') {
                  await frameBody.click();
                  await frame.evaluate((html) => {
                    document.body.innerHTML = html;
                    // 에디터 프레임워크에 변경 통지
                    document.body.dispatchEvent(
                      new Event('input', { bubbles: true }),
                    );
                    document.body.dispatchEvent(
                      new Event('change', { bubbles: true }),
                    );
                  }, body);
                  // iframe 본문 설정 후 부모 페이지의 CKEditor API로도 동기화 시도
                  await page.evaluate((html) => {
                    try {
                      const ck = (window as any).CKEDITOR;
                      if (ck && ck.instances) {
                        const keys = Object.keys(ck.instances);
                        if (keys.length > 0) {
                          ck.instances[keys[0]].setData(html);
                        }
                      }
                    } catch {
                      /* ignore */
                    }
                  }, body);
                  bodyInserted = true;
                  this.logger.log(`iframe 에디터로 본문 삽입 (${sel})`);
                  break;
                }
              }
            }
          }
        }
      }

      // 방법 2: contenteditable 기반 에디터 + 이벤트 트리거
      if (!bodyInserted) {
        const editableSelectors = [
          '#tinymce',
          '.mce-content-body',
          '#content',
          '.editor-content',
          '.ProseMirror',
          '[contenteditable="true"]',
        ];
        for (const sel of editableSelectors) {
          const editorArea = await page.$(sel);
          if (editorArea) {
            await editorArea.click();
            await editorArea.evaluate((el, html) => {
              (el as HTMLElement).innerHTML = html;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, body);
            bodyInserted = true;
            this.logger.log(`contenteditable 에디터로 본문 삽입 (${sel})`);
            break;
          }
        }
      }

      // 방법 3: HTML 모드 전환 후 텍스트에어리어 사용
      if (!bodyInserted) {
        // CKEditor HTML 소스 모드 전환 시도
        const switchedToSource = await page.evaluate(() => {
          try {
            const ck = (window as any).CKEDITOR;
            if (ck && ck.instances) {
              const keys = Object.keys(ck.instances);
              if (keys.length > 0) {
                ck.instances[keys[0]].setMode('source');
                return true;
              }
            }
          } catch {
            /* ignore */
          }
          // HTML 모드 전환 버튼 클릭 시도
          const htmlBtn = document.querySelector<HTMLElement>(
            '.btn_html, [data-mode="html"], .cke_button__source',
          );
          if (htmlBtn) {
            htmlBtn.click();
            return true;
          }
          return false;
        });

        if (switchedToSource) {
          await page.waitForTimeout(1000);
        }

        const textareaSelectors = [
          'textarea#content',
          'textarea.cke_source',
          'textarea.editor-textarea',
          'textarea[name="content"]',
          'textarea',
        ];
        for (const sel of textareaSelectors) {
          const textarea = await page.$(sel);
          if (textarea) {
            await textarea.fill(body);
            bodyInserted = true;
            this.logger.log(`textarea로 본문 삽입 (${sel})`);
            break;
          }
        }

        // 다시 WYSIWYG 모드로 복귀
        if (bodyInserted && switchedToSource) {
          await page.evaluate(() => {
            try {
              const ck = (window as any).CKEDITOR;
              if (ck && ck.instances) {
                const keys = Object.keys(ck.instances);
                if (keys.length > 0) {
                  ck.instances[keys[0]].setMode('wysiwyg');
                }
              }
            } catch {
              /* ignore */
            }
          });
          await page.waitForTimeout(1000);
        }
      }

      if (!bodyInserted) {
        const debugInfo = await page.evaluate(() => {
          const iframes = document.querySelectorAll('iframe');
          const editables = document.querySelectorAll(
            '[contenteditable="true"]',
          );
          const textareas = document.querySelectorAll('textarea');
          const hasCK = typeof (window as any).CKEDITOR !== 'undefined';
          return `URL: ${location.href}, CKEditor: ${hasCK}, iframes: ${iframes.length}, contenteditable: ${editables.length}, textareas: ${textareas.length}`;
        });
        return {
          success: false,
          error: `티스토리 본문 에디터를 찾을 수 없습니다. (${debugInfo})`,
        };
      }

      await page.waitForTimeout(1000);

      // ── 6. 발행: "완료" → "공개" → "공개 발행" ──
      this.logger.log('Step 6: 발행 시작...');

      // 6-1. "완료" 버튼 클릭
      const completeBtnClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (
            btn.textContent?.trim() === '완료' &&
            (btn as HTMLElement).offsetParent !== null
          ) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (!completeBtnClicked) {
        const btnList = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button'))
            .filter((b) => (b as HTMLElement).offsetParent !== null)
            .map((b) => b.textContent?.trim())
            .filter(Boolean),
        );
        return {
          success: false,
          error: `"완료" 버튼을 찾을 수 없습니다. 버튼: [${btnList.join(', ')}]`,
        };
      }
      this.logger.log('"완료" 버튼 클릭');

      // 6-2. 발행 다이얼로그 대기
      try {
        await page.waitForFunction(
          () => document.querySelectorAll('input[type="radio"]').length >= 2,
          { timeout: 5000 },
        );
      } catch {
        this.logger.warn('발행 다이얼로그 대기 타임아웃');
      }
      await page.waitForTimeout(1000);

      // 6-3. "공개" 라디오 선택 (Residential Proxy 사용 시 CAPTCHA 미발생 예상)
      const publicSelected = await page.evaluate(() => {
        const radios = document.querySelectorAll<HTMLInputElement>(
          'input[type="radio"]',
        );
        for (const radio of radios) {
          const container = radio.closest('div, span, label, li');
          const text = container?.textContent?.trim() || '';
          if (text === '공개') {
            radio.click();
            return true;
          }
        }
        return false;
      });
      this.logger.log(`공개 라디오 선택: ${publicSelected}`);
      await page.waitForTimeout(1000);

      // 6-4. 발행 버튼 클릭
      const visibleButtons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button'))
          .filter((b) => (b as HTMLElement).offsetParent !== null)
          .map((b) => b.textContent?.trim() || '')
          .filter(Boolean);
      });
      this.logger.log(
        `발행 다이얼로그 버튼 목록: [${visibleButtons.join(' | ')}]`,
      );

      const publishBtnClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button')).filter(
          (b) => (b as HTMLElement).offsetParent !== null,
        );

        // "공개 발행" 또는 "발행" 버튼
        for (const btn of buttons) {
          const text = btn.textContent?.trim() || '';
          if (text.includes('발행') && !btn.disabled) {
            btn.click();
            return text;
          }
        }
        // 폴백: "저장"/"등록" 버튼
        for (const btn of buttons) {
          const text = btn.textContent?.trim() || '';
          if (
            (text.includes('저장') || text.includes('등록')) &&
            !text.includes('저장중') &&
            !text.includes('임시') &&
            !btn.disabled
          ) {
            btn.click();
            return text;
          }
        }
        return null;
      });

      if (!publishBtnClicked) {
        return {
          success: false,
          error: `발행 버튼을 찾을 수 없습니다. 버튼: [${visibleButtons.join(', ')}]`,
        };
      }
      this.logger.log(`"${publishBtnClicked}" 버튼 클릭`);

      // 6-5. 결과 대기 → CAPTCHA 감지 시 AI Vision으로 풀이
      let publishSuccess = false;

      // 발행 직후 3초 대기
      await page.waitForTimeout(3000);

      // URL 변경 확인 (CAPTCHA 없이 바로 발행된 경우)
      if (!page.url().includes('/manage/newpost')) {
        publishSuccess = true;
        this.logger.log(`발행 성공 (CAPTCHA 없음): ${page.url()}`);
      }

      // CAPTCHA 감지 및 풀이 (최대 5회 시도)
      if (!publishSuccess) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const hasCaptcha = await page.evaluate(() => {
            const iframes = document.querySelectorAll('iframe');
            for (const f of iframes) {
              if (f.src?.includes('dkaptcha')) return true;
            }
            return false;
          });

          if (!hasCaptcha) break;

          this.logger.log(
            `dkaptcha CAPTCHA 감지 – AI Vision 풀이 시도 ${attempt + 1}/3`,
          );
          const solved = await this.solveDkaptcha(page);

          if (solved) {
            // 풀이 후 발행 완료 대기 (최대 10초)
            for (let w = 0; w < 10; w++) {
              await page.waitForTimeout(1000);
              if (!page.url().includes('/manage/newpost')) {
                publishSuccess = true;
                this.logger.log(`CAPTCHA 풀이 후 발행 성공: ${page.url()}`);
                break;
              }
            }
            if (publishSuccess) break;
          } else {
            this.logger.warn(
              `CAPTCHA 풀이 실패 (시도 ${attempt + 1}) – 새로풀기 시도`,
            );
            // 새로풀기 클릭 후 새 문제 로드 대기
            await this.resetDkaptcha(page);
            await page.waitForTimeout(4000 + Math.floor(Math.random() * 3000));
          }
        }
      }

      // 쿠키 저장
      const finalCookies = await context.cookies();
      await this.siteRepository.update(site.id, {
        sessionCookies: JSON.stringify(finalCookies),
      });

      const publishedUrl = page.url();
      this.logger.log(`발행 후 URL: ${publishedUrl}`);

      if (publishSuccess || !publishedUrl.includes('/manage/newpost')) {
        this.logger.log(
          `티스토리 발행 성공 [${site.siteName}] publishedUrl=${publishedUrl}`,
        );
        return { success: true, publishedUrl };
      }

      this.logger.error(
        `발행 실패 [${site.siteName}]: CAPTCHA 자동 풀이 5회 모두 실패`,
      );
      return {
        success: false,
        error: 'dkaptcha CAPTCHA 자동 풀이에 실패했습니다 (5회 시도).',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `티스토리 발행 실패 [${site.siteName}] url=${site.siteUrl}: ${msg}`,
      );
      return { success: false, error: msg };
    } finally {
      try {
        await context?.close();
      } catch {
        /* ignore */
      }
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // ── 유틸리티 ──

  private async createBrowser(options?: {
    useResidentialProxy?: boolean;
  }): Promise<Browser> {
    const proxyHost = process.env.PROXY_HOST;
    const proxyPort = process.env.PROXY_PORT;
    const proxyUser = process.env.PROXY_USERNAME;
    const proxyPass = process.env.PROXY_PASSWORD;
    const useProxy =
      options?.useResidentialProxy &&
      proxyHost &&
      proxyPort &&
      proxyUser &&
      proxyPass;

    this.logger.log(
      `CloakBrowser 스텔스 브라우저 실행${useProxy ? ` (Proxy: ${proxyHost}:${proxyPort})` : ''}`,
    );

    try {
      const { launch } = await (Function(
        'return import("cloakbrowser")',
      )() as Promise<typeof import('cloakbrowser')>);

      const launchOptions: Record<string, unknown> = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      };

      if (useProxy) {
        launchOptions.proxy = {
          server: `http://${proxyHost}:${proxyPort}`,
          username: proxyUser,
          password: proxyPass,
        };
      } else if (options?.useResidentialProxy) {
        this.logger.warn('PROXY_* 환경변수 미설정 – 프록시 없이 실행');
      }

      return (await launch(launchOptions)) as unknown as Browser;
    } catch (err) {
      this.logger.error(
        `브라우저 실행 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  // ── dkaptcha CAPTCHA 풀이 (AI Vision) ──

  /**
   * dkaptcha iframe을 찾아 AI Vision으로 퀴즈를 풀고 제출한다.
   * @returns 풀이 성공 여부
   */
  private async solveDkaptcha(page: Page): Promise<boolean> {
    try {
      // 1. dkaptcha iframe 찾기 (로드 대기 포함)
      await page.waitForTimeout(1500);
      const dkFrame = await this.getDkaptchaFrame(page);
      if (!dkFrame) {
        this.logger.warn('dkaptcha iframe을 찾을 수 없음');
        return false;
      }

      // iframe 내 콘텐츠 로드 대기 (최대 2회 시도)
      let iframeLoaded = false;
      for (let loadAttempt = 0; loadAttempt < 2; loadAttempt++) {
        try {
          await dkFrame.waitForSelector('#container_dkaptcha', {
            timeout: 8000,
          });
          await dkFrame.waitForSelector('.info_question', { timeout: 5000 });
          iframeLoaded = true;
          break;
        } catch {
          this.logger.warn(
            `dkaptcha 로드 대기 ${loadAttempt + 1}/2 타임아웃 – 추가 대기`,
          );
          await page.waitForTimeout(3000);
        }
      }

      if (!iframeLoaded) {
        this.logger.warn('dkaptcha iframe 콘텐츠 로드 실패');
        return false;
      }

      // 2. 퀴즈 정보 추출 (지도 이미지 URL + 빈칸 패턴)
      const quizInfo = await dkFrame.evaluate(() => {
        const container = document.getElementById('container_dkaptcha');
        const imgSrc = container?.getAttribute('data-resource') || '';

        const questionEl = document.querySelector('.info_question');
        if (!questionEl) return { imgSrc, parts: [] as { text: string; isBlank: boolean }[], fullText: '' };

        const spans = questionEl.querySelectorAll('span');
        const parts: { text: string; isBlank: boolean }[] = [];
        for (const span of spans) {
          parts.push({
            text: span.textContent || '',
            isBlank: span.classList.contains('blank_txt'),
          });
        }

        const fullText = questionEl.textContent || '';

        return { imgSrc, parts, fullText };
      });

      if (!quizInfo || quizInfo.parts.length === 0) {
        this.logger.warn(
          `dkaptcha 퀴즈 정보 추출 실패 (imgSrc=${quizInfo?.imgSrc || 'none'}, parts=${quizInfo?.parts?.length || 0})`,
        );
        return false;
      }
      this.logger.log(`퀴즈 전체 텍스트: "${quizInfo.fullText}"`);

      // 3. 빈칸 개수와 알려진 텍스트 파싱
      // 패턴 예: [빈칸][빈칸]코팰리체 → before / 오피스[빈칸][빈칸] → after
      let blankCount = 0;
      const textBefore: string[] = []; // 빈칸 앞에 오는 텍스트
      const textAfter: string[] = []; // 빈칸 뒤에 오는 텍스트
      let blankSeen = false;

      for (const part of quizInfo.parts) {
        if (part.isBlank) {
          blankCount++;
          blankSeen = true;
        } else if (part.text) {
          if (blankSeen) {
            textAfter.push(part.text);
          } else {
            textBefore.push(part.text);
          }
        }
      }
      const knownBefore = textBefore.join('');
      const knownAfter = textAfter.join('');
      this.logger.log(
        `퀴즈: 빈칸 ${blankCount}개, 패턴="${knownBefore}[${'□'.repeat(blankCount)}]${knownAfter}"`,
      );

      // 4. CAPTCHA 지도 이미지 획득 (iframe 스크린샷 우선 → data-resource fallback)
      let imgBase64: string | null = null;
      let mediaType: 'image/jpeg' | 'image/png' = 'image/png';

      // 4-1. dkaptcha iframe 요소 스크린샷 (브라우저 렌더링 품질, 가장 정확)
      try {
        const iframes = await page.$$('iframe');
        for (const iframe of iframes) {
          const src = (await iframe.getAttribute('src')) || '';
          if (src.includes('dkaptcha')) {
            const screenshotBuf = await iframe.screenshot({ type: 'png' });
            imgBase64 = screenshotBuf.toString('base64');
            mediaType = 'image/png';
            this.logger.log(
              `dkaptcha iframe 스크린샷 성공 (${Math.round(screenshotBuf.length / 1024)}KB)`,
            );
            break;
          }
        }
      } catch (e) {
        this.logger.warn(
          `iframe 스크린샷 실패: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // 4-2. 스크린샷 실패 시 data-resource URL로 이미지 다운로드
      if (!imgBase64) {
        const imgUrl = quizInfo.imgSrc.startsWith('http')
          ? quizInfo.imgSrc
          : `https://${quizInfo.imgSrc}`;
        this.logger.log(`data-resource URL로 이미지 다운로드 시도: ${imgUrl}`);
        const downloaded = await this.fetchImageAsBase64(imgUrl);
        if (downloaded) {
          imgBase64 = downloaded.base64;
          mediaType = downloaded.mediaType;
          this.logger.log(
            `이미지 다운로드 성공 (${downloaded.mediaType}, ${Math.round(downloaded.base64.length * 0.75 / 1024)}KB)`,
          );
        }
      }

      // 4-3. 전체 페이지 스크린샷 최종 fallback
      if (!imgBase64) {
        this.logger.warn('이미지 획득 실패 – 전체 페이지 스크린샷 fallback');
        try {
          const screenshotBuf = await page.screenshot({ type: 'png' });
          imgBase64 = screenshotBuf.toString('base64');
          mediaType = 'image/png';
        } catch {
          this.logger.warn('스크린샷도 실패');
          return false;
        }
      }

      // 5. Claude Vision API로 빈칸 글자를 직접 읽기
      const answer = await this.callClaudeVision(
        imgBase64,
        mediaType,
        knownBefore,
        knownAfter,
        blankCount,
      );
      if (!answer) {
        this.logger.warn('Claude Vision이 정답을 인식하지 못함');
        return false;
      }

      this.logger.log(`Claude Vision 정답: "${answer}"`);

      // 7. 답변 입력 및 제출
      // fill() 후 input 이벤트를 발생시켜 submit 버튼을 활성화
      await dkFrame.fill('#inpDkaptcha', answer);
      await dkFrame.evaluate(() => {
        const inp = document.getElementById('inpDkaptcha') as HTMLInputElement;
        if (inp) {
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('keyup', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // submit 버튼 강제 활성화 (이벤트로 안 될 경우 대비)
        const btn = document.getElementById(
          'btn_dkaptcha_submit',
        ) as HTMLButtonElement;
        if (btn) btn.disabled = false;
      });
      await dkFrame.waitForTimeout(500);

      // 클릭 대신 JS로 직접 submit 호출 (disabled 버튼 클릭 타임아웃 방지)
      await dkFrame.evaluate(() => {
        const btn = document.getElementById(
          'btn_dkaptcha_submit',
        ) as HTMLButtonElement;
        if (btn) {
          btn.disabled = false;
          btn.click();
        }
      });
      await page.waitForTimeout(3000);

      // 8. 결과 확인
      const afterSubmit = await dkFrame.evaluate(() => {
        const errorEl = document.getElementById('error');
        const errorText = errorEl?.textContent?.trim() || '';
        // CAPTCHA가 사라졌으면 성공
        const container = document.getElementById('container_dkaptcha');
        const isHidden =
          !container ||
          container.style.display === 'none' ||
          container.offsetParent === null;
        return { errorText, isHidden };
      });

      if (afterSubmit.errorText) {
        this.logger.warn(`CAPTCHA 오답: ${afterSubmit.errorText}`);
        return false;
      }

      // iframe이 사라졌거나 URL이 변경되었으면 성공
      if (afterSubmit.isHidden || !page.url().includes('/manage/newpost')) {
        return true;
      }

      // 추가 대기 후 확인
      await page.waitForTimeout(3000);
      return !page.url().includes('/manage/newpost');
    } catch (err) {
      this.logger.error(
        `solveDkaptcha 에러: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** dkaptcha iframe의 Frame 객체를 반환 */
  private async getDkaptchaFrame(page: Page): Promise<Frame | null> {
    const iframes = await page.$$('iframe');
    for (const iframe of iframes) {
      const src = (await iframe.getAttribute('src')) || '';
      if (src.includes('dkaptcha')) {
        return iframe.contentFrame();
      }
    }
    return null;
  }

  /** dkaptcha "새로 풀기" 버튼 클릭 */
  private async resetDkaptcha(page: Page): Promise<void> {
    try {
      const dkFrame = await this.getDkaptchaFrame(page);
      if (dkFrame) {
        await dkFrame.click('#btn_dkaptcha_reset');
      }
    } catch {
      /* ignore */
    }
  }

  /** 이미지 URL을 base64로 다운로드 (content-type 감지 포함) */
  private async fetchImageAsBase64(
    url: string,
  ): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' } | null> {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://tistory.com/',
        },
      });
      if (!resp.ok) {
        this.logger.warn(`이미지 다운로드 HTTP ${resp.status}: ${url}`);
        return null;
      }
      const contentType = resp.headers.get('content-type') || '';
      const mediaType: 'image/jpeg' | 'image/png' = contentType.includes('png')
        ? 'image/png'
        : 'image/jpeg';
      const buf = Buffer.from(await resp.arrayBuffer());
      return { base64: buf.toString('base64'), mediaType };
    } catch (err) {
      this.logger.warn(
        `이미지 다운로드 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Claude Vision API로 지도 이미지에서 빈칸에 들어갈 글자를 직접 읽는다.
   * @param knownBefore 빈칸 앞에 오는 알려진 텍스트 (빈칸이 맨 앞이면 빈 문자열)
   * @param knownAfter 빈칸 뒤에 오는 알려진 텍스트 (빈칸이 맨 뒤면 빈 문자열)
   */
  private async callClaudeVision(
    imgBase64: string,
    mediaType: 'image/jpeg' | 'image/png',
    knownBefore: string,
    knownAfter: string,
    blankCount: number,
  ): Promise<string | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      this.logger.error('ANTHROPIC_API_KEY 환경변수 미설정');
      return null;
    }

    const pattern = `${knownBefore}${'□'.repeat(blankCount)}${knownAfter}`;

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-20250514',
          max_tokens: 300,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: imgBase64,
                  },
                },
                {
                  type: 'text',
                  text: `카카오맵 지도 이미지에서 장소명을 읽어 CAPTCHA 퀴즈를 풀어야 합니다.

## 퀴즈
패턴: "${pattern}"
- □ 는 빈칸(각 1글자). 총 ${blankCount}글자를 채워야 합니다.
- 앞부분: "${knownBefore}" / 뒷부분: "${knownAfter}"
- 정답 = "${knownBefore}" + [${blankCount}글자 정답] + "${knownAfter}" → 이 전체가 지도에 보이는 장소명

## 중요 규칙
- 정답은 반드시 정확히 ${blankCount}글자여야 합니다.
- "${knownBefore}" + 정답 + "${knownAfter}" 를 합치면 지도에 실제로 적힌 장소명이 되어야 합니다.
- 글자 수가 안 맞으면 다른 장소명을 찾으세요.

## 예시
- 패턴 "경□□박물관" (2칸), 지도에 "경기도박물관" → 답: 기도 (경+기도+박물관=경기도박물관, 6글자 ✓)
- 패턴 "□□프라자" (2칸), 지도에 "코아프라자" → 답: 코아 (코아+프라자=코아프라자, 5글자 ✓)
- 패턴 "한국□□학교" (2칸), 지도에 "한국중학교" → 답은 "중학"이 아님! 한국+중학+학교=한국중학학교(7글자)는 틀림. 지도에서 "한국대중학교"를 찾으면 답: 대중 ✓

## 풀이
1. 지도에서 보이는 모든 장소명을 정확하게 읽어 나열하세요.
2. 각 장소명에 대해 "${knownBefore}"로 시작하고 "${knownAfter}"로 끝나는지 확인하세요.
3. "${knownBefore}"와 "${knownAfter}" 사이의 글자가 정확히 ${blankCount}개인 장소명을 찾으세요.
4. 그 ${blankCount}글자만 답하세요.

## 출력
PLACES: [지도에 보이는 장소명들]
MATCH: [패턴과 일치하는 장소명 전체]
ANSWER: [빈칸 ${blankCount}글자만, 반드시 ${blankCount}글자]`,
                },
              ],
            },
          ],
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        this.logger.error(`Claude API 오류: ${resp.status} ${errText}`);
        return null;
      }

      const data = await resp.json();
      const raw = data?.content?.[0]?.text?.trim() || '';
      this.logger.log(`Claude Vision 원본 응답: ${raw.substring(0, 300)}`);

      // ANSWER: 라인에서 정답 추출
      const answerMatch = raw.match(/ANSWER:\s*(.+)/i);
      let candidate: string | null = null;

      if (answerMatch) {
        const hangul = answerMatch[1].replace(/[^가-힣]/g, '');
        if (hangul.length === blankCount) {
          candidate = hangul;
        } else {
          this.logger.warn(
            `ANSWER 글자수 불일치: "${hangul}" (${hangul.length}글자, 필요: ${blankCount})`,
          );
        }
      }

      // fallback: MATCH 라인에서 패턴 매칭으로 추출
      if (!candidate) {
        const matchLine = raw.match(/MATCH:\s*(.+)/i);
        if (matchLine) {
          const matchedName = matchLine[1].replace(/[^가-힣]/g, '');
          // knownBefore + answer + knownAfter = matchedName
          if (
            matchedName.startsWith(knownBefore) &&
            matchedName.endsWith(knownAfter)
          ) {
            const afterLen = knownAfter.length || 0;
            const extracted = afterLen > 0
              ? matchedName.slice(knownBefore.length, -afterLen)
              : matchedName.slice(knownBefore.length);
            if (extracted.length === blankCount) {
              candidate = extracted;
              this.logger.log(
                `MATCH에서 정답 추출: "${matchedName}" → "${candidate}"`,
              );
            }
          }
        }
      }

      // fallback: 마지막 줄에서 한글 추출 (정확히 blankCount일 때만)
      if (!candidate) {
        const lines = raw.split('\n').filter((l: string) => l.trim());
        const lastLine = lines[lines.length - 1] || '';
        const hangul = lastLine.replace(/[^가-힣]/g, '');
        if (hangul.length === blankCount) {
          candidate = hangul;
        }
      }

      return candidate;
    } catch (err) {
      this.logger.error(
        `Claude Vision 호출 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private parseCookieString(
    cookies: string,
    domain: string,
  ): Array<{ name: string; value: string; domain: string; path: string }> {
    const trimmed = cookies.trim();

    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        this.logger.warn('쿠키 JSON 파싱 실패, 문자열 형식으로 시도');
      }
    }

    return trimmed
      .split(';')
      .map((pair) => pair.trim())
      .filter((pair) => pair.includes('='))
      .map((pair) => {
        const [name, ...rest] = pair.split('=');
        return {
          name: name.trim(),
          value: rest.join('=').trim(),
          domain,
          path: '/',
        };
      });
  }
}

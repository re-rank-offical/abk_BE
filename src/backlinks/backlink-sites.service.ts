import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Browser, BrowserContext } from 'playwright-core';

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

    const results: BacklinkPost[] = [];

    for (const site of sites) {
      // 사이트 간 랜덤 딜레이 (CAPTCHA 방지 – 30~60초)
      if (results.length > 0) {
        const delay = 30000 + Math.random() * 30000;
        this.logger.log(
          `다음 사이트 발행까지 ${Math.round(delay / 1000)}초 대기 (CAPTCHA 방지)`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

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

      results.push(await this.postRepository.save(post));
    }

    return results;
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

      // 2. 세션 워밍업: sessionLength를 높여 dkaptcha 봇 탐지 완화
      const blogName =
        (site.siteUrl.match(/https?:\/\/([^.]+)\.tistory\.com/) || [])[1] || '';
      this.logger.log(`세션 워밍업 시작 (blog: ${blogName})...`);

      // 2-1) 티스토리 홈 방문
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

      // 2-2) 블로그 홈 방문
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

        // 2-3) 관리 대시보드 방문
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

      // 6-5. 결과 대기: 페이지 이동(성공) or CAPTCHA(차단) 감지
      let publishSuccess = false;
      let captchaDetected = false;

      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(1000);

        const currentUrl = page.url();

        // URL이 글쓰기 페이지에서 벗어나면 성공
        if (!currentUrl.includes('/manage/newpost')) {
          publishSuccess = true;
          this.logger.log(`발행 성공: URL 변경 → ${currentUrl}`);
          break;
        }

        // dkaptcha iframe 감지
        if (!captchaDetected) {
          captchaDetected = await page.evaluate(() => {
            const iframes = document.querySelectorAll('iframe');
            for (const f of iframes) {
              if (f.src?.includes('dkaptcha')) return true;
            }
            return false;
          });
          if (captchaDetected) {
            this.logger.warn(`dkaptcha CAPTCHA 감지 (${i + 1}초차)`);
          }
        }

        // CAPTCHA가 8초 이상 지속되면 포기
        if (captchaDetected && i >= 8) {
          this.logger.error('dkaptcha CAPTCHA 8초 이상 지속 – 자동 발행 불가');
          break;
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

      // 실패 진단
      const diagnosis = await page.evaluate(() => {
        const result: string[] = [];
        document.querySelectorAll('iframe').forEach((f) => {
          if (f.src?.includes('dkaptcha'))
            result.push(`CAPTCHA: ${f.src.substring(0, 100)}`);
        });
        const buttons = document.querySelectorAll('button');
        const btnTexts: string[] = [];
        buttons.forEach((btn) => {
          const t = btn.textContent?.trim();
          if (t && (btn as HTMLElement).offsetParent !== null) {
            btnTexts.push(`${t}(disabled=${btn.disabled})`);
          }
        });
        result.push(`buttons: [${btnTexts.join('|')}]`);
        return result.join(' | ');
      });

      this.logger.error(
        `발행 실패 [${site.siteName}]: ${captchaDetected ? 'dkaptcha CAPTCHA 감지' : '알 수 없는 원인'}. ${diagnosis}`,
      );
      return {
        success: false,
        error: captchaDetected
          ? 'dkaptcha CAPTCHA가 감지되어 자동 발행이 차단되었습니다. 티스토리가 봇 방지 CAPTCHA를 강화한 것으로 보입니다. (원인: 데이터센터 IP, 짧은 세션 등)'
          : `발행 완료되지 않음. URL: ${publishedUrl}. 진단: ${diagnosis}`,
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
      options?.useResidentialProxy && proxyHost && proxyPort && proxyUser && proxyPass;

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
        this.logger.warn(
          'PROXY_* 환경변수 미설정 – 프록시 없이 실행',
        );
      }

      return (await launch(launchOptions)) as unknown as Browser;
    } catch (err) {
      this.logger.error(
        `브라우저 실행 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
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

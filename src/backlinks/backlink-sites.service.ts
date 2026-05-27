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
      browser = await this.createBrowser();
      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
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

      // 다이얼로그(confirm/alert) 자동 수락 – 임시저장 복구 팝업 등 차단 방지
      page.on('dialog', async (dialog) => {
        this.logger.log(
          `다이얼로그 감지: ${dialog.type()} - ${dialog.message()}`,
        );
        await dialog.accept();
      });

      // 2. 글쓰기 페이지 이동
      const writeUrl =
        site.writeUrl || `${site.siteUrl.replace(/\/$/, '')}/manage/newpost`;
      await page.goto(writeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // 3. 로그인 필요 여부 확인 (카카오 로그인 페이지로 리다이렉트 체크)
      const currentUrl = page.url();
      const needsLogin =
        currentUrl.includes('accounts.kakao.com') ||
        currentUrl.includes('tistory.com/auth/login');

      if (needsLogin) {
        if (!site.loginUsername || !site.loginPassword) {
          return {
            success: false,
            error: '카카오 로그인 정보가 설정되지 않았습니다.',
          };
        }

        // 티스토리 로그인 페이지인 경우 카카오 로그인 버튼 클릭
        if (currentUrl.includes('tistory.com/auth/login')) {
          const kakaoBtn = await page.$('.btn_login.link_kakao_id');
          if (kakaoBtn) {
            await kakaoBtn.click();
            await page.waitForTimeout(3000);
          }
        }

        // 카카오 로그인 폼
        const emailInput = await page.$(
          'input[name="loginId"], input[name="loginKey"], #loginId--1',
        );
        if (emailInput) {
          await emailInput.click();
          await emailInput.fill(site.loginUsername);
        }

        const pwInput = await page.$('input[name="password"], #password--2');
        if (pwInput) {
          await pwInput.click();
          await pwInput.fill(site.loginPassword);
        }

        // 로그인 버튼 클릭
        const loginBtn = await page.$(
          'button[type="submit"], .btn_g.btn_confirm.submit',
        );
        if (loginBtn) {
          await loginBtn.click();
          await page.waitForTimeout(5000);
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

      // 4. 제목 입력 - 티스토리 에디터
      const titleSelectors = [
        '#post-title-inp',
        'input[name="title"]',
        '.tit_post input',
        'input[placeholder*="제목"]',
      ];
      let titleInput = null;
      for (const sel of titleSelectors) {
        titleInput = await page.$(sel);
        if (titleInput) break;
      }
      if (titleInput) {
        await titleInput.click();
        await titleInput.fill(title);
      } else {
        return {
          success: false,
          error: '티스토리 제목 입력 필드를 찾을 수 없습니다.',
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

      // 네트워크 요청 캡처 (재시도 루프 밖에서 셋업)
      const capturedRequests: Array<{
        url: string;
        method: string;
        postData: string | null;
      }> = [];
      page.on('request', (req) => {
        if (
          req.method() === 'POST' ||
          req.url().includes('/manage/') ||
          req.url().includes('/api/')
        ) {
          capturedRequests.push({
            url: req.url(),
            method: req.method(),
            postData: req.postData()?.substring(0, 500) || null,
          });
        }
      });

      // 6~10. 발행 시도 (CAPTCHA 감지 시 재시도)
      const maxPublishRetries = 3;
      for (
        let publishAttempt = 1;
        publishAttempt <= maxPublishRetries;
        publishAttempt++
      ) {
        if (publishAttempt > 1) {
          this.logger.log(
            `발행 재시도 ${publishAttempt}/${maxPublishRetries}`,
          );
        }
        capturedRequests.length = 0;

      // 6. "완료" 버튼 클릭 → 발행 설정 다이얼로그 열기
      const completeBtnClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.trim() === '완료' && btn.offsetParent !== null) {
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
          error: `티스토리 "완료" 버튼을 찾을 수 없습니다. 페이지 버튼: [${btnList.join(', ')}]`,
        };
      }
      this.logger.log('"완료" 버튼 클릭 → 발행 레이어 열기');

      // 발행 다이얼로그 렌더링 대기
      try {
        await page.waitForFunction(
          () => document.querySelectorAll('input[type="radio"]').length >= 2,
          { timeout: 5000 },
        );
      } catch {
        this.logger.warn('발행 다이얼로그 라디오 버튼 대기 타임아웃');
      }
      await page.waitForTimeout(1000);

      // 7. "공개" 라디오 버튼 선택 (기본값이 "비공개"이므로 반드시 변경)
      const publicSelected = await page.evaluate(() => {
        const radios = document.querySelectorAll<HTMLInputElement>(
          'input[type="radio"]',
        );
        for (const radio of radios) {
          // 라디오의 부모/조부모에서 텍스트 확인
          const container = radio.closest('div, span, label, li');
          const text = container?.textContent?.trim() || '';
          // "공개"만 정확히 매칭 ("공개(보호)", "비공개" 제외)
          if (text === '공개') {
            radio.click();
            return 'exact';
          }
        }
        // 폴백: "공개"로 시작하고 "보호"/"비공개"가 아닌 라디오
        for (const radio of radios) {
          const container = radio.closest('div, span, label, li');
          const text = container?.textContent?.trim() || '';
          if (
            text.startsWith('공개') &&
            !text.includes('보호') &&
            !text.includes('비공개')
          ) {
            radio.click();
            return 'startsWith';
          }
        }
        return null;
      });
      if (publicSelected) {
        this.logger.log(`공개 라디오 선택됨 (match: ${publicSelected})`);
      } else {
        this.logger.warn('공개 라디오를 찾지 못함');
      }

      await page.waitForTimeout(1000);

      // 8. "공개 발행" 버튼 클릭
      const publishResult = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        // 우선순위 1: 정확히 "공개 발행"
        for (const btn of buttons) {
          if (
            btn.textContent?.trim() === '공개 발행' &&
            btn.offsetParent !== null
          ) {
            btn.click();
            return '공개 발행';
          }
        }
        // 우선순위 2: "발행"을 포함하되 "비공개" 미포함
        for (const btn of buttons) {
          const t = btn.textContent?.trim() || '';
          if (
            t.includes('발행') &&
            !t.includes('비공개') &&
            btn.offsetParent !== null
          ) {
            btn.click();
            return t;
          }
        }
        // 진단: 현재 보이는 버튼 목록 반환
        const visible = Array.from(buttons)
          .filter((b) => (b as HTMLElement).offsetParent !== null)
          .map((b) => b.textContent?.trim())
          .filter(Boolean);
        return `NOT_FOUND:[${visible.join('|')}]`;
      });

      if (publishResult.startsWith('NOT_FOUND:')) {
        return {
          success: false,
          error: `티스토리 "공개 발행" 버튼을 찾을 수 없습니다. 버튼목록: ${publishResult}`,
        };
      }
      this.logger.log(`발행 버튼 클릭: "${publishResult}"`);
      await page.waitForTimeout(5000);

      // 캡처된 네트워크 요청 로깅
      this.logger.log(
        `캡처된 요청 (${capturedRequests.length}건): ${JSON.stringify(capturedRequests)}`,
      );

      // 8.5. CAPTCHA 감지 및 재시도
      const hasCaptcha = await page.evaluate(() => {
        return !!(
          document.querySelector('.capcha_layer') ||
          document.querySelector('iframe[src*="dkaptcha"]') ||
          document.querySelector('[class*="dkaptcha"]') ||
          document.querySelector('[id*="dkaptcha"]')
        );
      });

      if (hasCaptcha) {
        this.logger.warn(
          `CAPTCHA(dkaptcha) 감지 (시도 ${publishAttempt}/${maxPublishRetries})`,
        );

        // CAPTCHA/발행 레이어 닫기
        await page.evaluate(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if (
              btn.textContent?.trim() === '닫기' &&
              (btn as HTMLElement).offsetParent !== null
            ) {
              btn.click();
              break;
            }
          }
        });
        await page.waitForTimeout(1000);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);

        if (publishAttempt < maxPublishRetries) {
          const retryDelay = 60000 + Math.random() * 60000; // 60~120초
          this.logger.log(
            `${Math.round(retryDelay / 1000)}초 후 재시도합니다...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }

        // 마지막 시도에서도 CAPTCHA → 최종 실패
        const captchaCookies = await context.cookies();
        await this.siteRepository.update(site.id, {
          sessionCookies: JSON.stringify(captchaCookies),
        });
        return {
          success: false,
          error: `CAPTCHA가 ${maxPublishRetries}회 반복 발생하여 발행에 실패했습니다.`,
        };
      }

      // 9. 발행 후 쿠키 저장
      const finalCookies = await context.cookies();
      await this.siteRepository.update(site.id, {
        sessionCookies: JSON.stringify(finalCookies),
      });

      // 10. 발행 결과 검증
      const publishedUrl = page.url();
      this.logger.log(`발행 후 URL: ${publishedUrl}`);

      // 글쓰기 페이지에 여전히 머물러 있으면 발행 실패로 판단
      if (
        publishedUrl.includes('/manage/newpost') ||
        publishedUrl.includes('accounts.kakao.com') ||
        publishedUrl.includes('tistory.com/auth/login')
      ) {
        // 페이지 상태 진단
        const diagnosis = await page.evaluate(() => {
          const result: string[] = [];

          // CAPTCHA / iframe 감지
          const iframes = document.querySelectorAll('iframe');
          iframes.forEach((f) => {
            const src = f.src || f.getAttribute('src') || '';
            if (src) result.push(`iframe: ${src.substring(0, 100)}`);
          });

          // DKAPTCHA 감지
          const captchaEl = document.querySelector(
            '[class*="captcha"], [id*="captcha"], [class*="dkaptcha"], [id*="dkaptcha"]',
          );
          if (captchaEl)
            result.push(`CAPTCHA발견: ${captchaEl.className || captchaEl.id}`);

          // 에러 메시지
          const errorEl = document.querySelector(
            '.error-message, .alert-error, .txt_error, .layer_alert, .layer_popup',
          );
          if (errorEl)
            result.push(
              `에러: ${errorEl.textContent?.trim()?.substring(0, 200)}`,
            );

          // 버튼 상태 확인 ("저장중" 등)
          const buttons = document.querySelectorAll('button');
          const btnTexts: string[] = [];
          buttons.forEach((btn) => {
            const t = btn.textContent?.trim();
            if (t && (btn as HTMLElement).offsetParent !== null) {
              btnTexts.push(`${t}(disabled=${btn.disabled})`);
            }
          });
          result.push(`buttons: [${btnTexts.join('|')}]`);

          // 레이어/모달 감지
          const layers = document.querySelectorAll(
            '.layer_publish, .mce-container, [class*="layer"], [class*="modal"], [class*="popup"]',
          );
          layers.forEach((l) => {
            const style = window.getComputedStyle(l);
            if (style.display !== 'none') {
              result.push(`layer: ${l.className.substring(0, 60)} visible`);
            }
          });

          return result.join(' | ');
        });

        this.logger.error(`발행 실패 진단 [${site.siteName}]: ${diagnosis}`);

        return {
          success: false,
          error: `발행이 완료되지 않았습니다. 현재 URL: ${publishedUrl}. 진단: ${diagnosis}`,
        };
      }

      this.logger.log(
        `티스토리 발행 성공 [${site.siteName}] publishedUrl=${publishedUrl}`,
      );
      return { success: true, publishedUrl };
      } // for (publishAttempt) – CAPTCHA 재시도 루프 끝

      // 모든 재시도 소진 (이론적으로 도달하지 않음)
      return {
        success: false,
        error: `발행 재시도 ${maxPublishRetries}회 모두 실패했습니다.`,
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

  private async createBrowser(): Promise<Browser> {
    this.logger.log('CloakBrowser 스텔스 브라우저 실행');

    try {
      const { launch } = await (Function(
        'return import("cloakbrowser")',
      )() as Promise<typeof import('cloakbrowser')>);

      return (await launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      })) as unknown as Browser;
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

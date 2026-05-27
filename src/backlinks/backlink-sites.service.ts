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

      // ── 6A. JS 번들 분석: 실제 발행 엔드포인트 탐색 ──
      this.logger.log('Step 6A: JS 번들 분석으로 실제 발행 엔드포인트 탐색...');

      const jsBundleFindings = await page.evaluate(async () => {
        const findings: string[] = [];

        // 현재 페이지의 모든 script src 수집
        const scriptUrls = Array.from(
          document.querySelectorAll<HTMLScriptElement>('script[src]'),
        )
          .map((s) => s.src)
          .filter(
            (src) =>
              src.includes('tistory') ||
              src.includes('/manage/') ||
              src.includes('.js'),
          );

        findings.push(
          `스크립트 목록(${scriptUrls.length}개): ${scriptUrls.slice(0, 10).join(', ')}`,
        );

        // 관심 번들만 분석 (admin/manage 관련)
        const targetScripts = scriptUrls.filter(
          (src) =>
            src.includes('editor') ||
            src.includes('post') ||
            src.includes('write') ||
            src.includes('publish') ||
            src.includes('manage') ||
            src.includes('app.') ||
            src.includes('main.') ||
            src.includes('chunk'),
        );

        findings.push(
          `분석 대상 번들(${targetScripts.length}개): ${targetScripts.slice(0, 5).join(', ')}`,
        );

        for (const scriptUrl of targetScripts.slice(0, 5)) {
          try {
            const res = await fetch(scriptUrl, { credentials: 'include' });
            if (!res.ok) continue;
            const text = await res.text();

            // /manage/ 엔드포인트 패턴 추출
            const manageMatches = text.match(
              /["'`](\/manage\/[a-zA-Z0-9/_\-{}:]+)["'`]/g,
            );
            if (manageMatches) {
              const unique = [...new Set(manageMatches)].slice(0, 20);
              findings.push(
                `[${scriptUrl.split('/').pop()}] /manage/ 엔드포인트: ${unique.join(', ')}`,
              );
            }

            // dkaptcha 콜백 패턴 추출
            const dkaptchaMatches = text.match(/dkaptcha[^"'`\s]{0,100}/g);
            if (dkaptchaMatches) {
              const unique = [...new Set(dkaptchaMatches)].slice(0, 10);
              findings.push(
                `[${scriptUrl.split('/').pop()}] dkaptcha 패턴: ${unique.join(' | ')}`,
              );
            }

            // publish/save 관련 함수명 추출
            const publishMatches = text.match(
              /(?:publish|save|submit|post)[A-Za-z]*\s*[=:(]/g,
            );
            if (publishMatches) {
              const unique = [...new Set(publishMatches)].slice(0, 10);
              findings.push(
                `[${scriptUrl.split('/').pop()}] publish/save 함수: ${unique.join(', ')}`,
              );
            }
          } catch (e) {
            findings.push(`[번들 분석 실패] ${scriptUrl}: ${String(e)}`);
          }
        }

        // 인라인 스크립트에서도 탐색
        const inlineScripts = Array.from(
          document.querySelectorAll<HTMLScriptElement>('script:not([src])'),
        )
          .map((s) => s.textContent || '')
          .join('\n');

        const inlineManage = inlineScripts.match(
          /["'`](\/manage\/[a-zA-Z0-9/_\-{}:]+)["'`]/g,
        );
        if (inlineManage) {
          const unique = [...new Set(inlineManage)].slice(0, 20);
          findings.push(
            `[인라인 스크립트] /manage/ 엔드포인트: ${unique.join(', ')}`,
          );
        }

        return findings;
      });

      for (const finding of jsBundleFindings) {
        this.logger.log(`[JS번들분석] ${finding}`);
      }

      // ── 6B. autosave 기반 발행: entryId 획득 후 publish 엔드포인트 시도 ──
      this.logger.log('Step 6B: autosave 기반 발행 시도...');

      // CKEditor에서 실제 렌더링된 HTML 가져오기
      const editorContent = await page.evaluate(() => {
        try {
          const ck = (window as any).CKEDITOR;
          if (ck?.instances) {
            const keys = Object.keys(ck.instances);
            if (keys.length > 0) return ck.instances[keys[0]].getData();
          }
        } catch {
          /* ignore */
        }
        return null;
      });
      const publishContent = editorContent || body;
      this.logger.log(
        `발행 콘텐츠 길이: ${publishContent.length}, CKEditor 사용: ${!!editorContent}`,
      );

      const autosaveResult = await page.evaluate(
        async (params: { title: string; content: string }) => {
          const { title, content } = params;

          // 1단계: autosave로 entryId/draftSequence 획득
          let entryId: number | null = null;
          let draftSequence: number | null = null;
          let autosaveStatus = -1;
          let autosaveBody = '';

          try {
            const saveRes = await fetch('/manage/autosave', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title,
                content,
                tags: '',
                categoryId: 0,
                thumbnail: '',
                draftSequence: null,
                totalWritingTimeMs: 0,
              }),
              credentials: 'include',
            });
            autosaveStatus = saveRes.status;
            autosaveBody = await saveRes.text();

            if (saveRes.ok) {
              try {
                const data = JSON.parse(autosaveBody);
                entryId = data.entryId ?? data.postId ?? data.id ?? null;
                draftSequence = data.draftSequence ?? data.sequence ?? null;
              } catch {
                /* JSON 파싱 실패 */
              }
            }
          } catch (e) {
            autosaveBody = String(e);
          }

          const log: Array<{ ep: string; status: number; body: string }> = [];
          log.push({
            ep: '/manage/autosave',
            status: autosaveStatus,
            body: autosaveBody.substring(0, 500),
          });

          if (!entryId) {
            return { success: false, log };
          }

          // 2단계: entryId를 이용한 publish 엔드포인트 순차 시도
          const publishEndpoints = [
            { method: 'POST', url: `/manage/post/${entryId}/publish` },
            { method: 'POST', url: `/manage/entry/${entryId}/publish` },
            {
              method: 'PUT',
              url: `/manage/post/${entryId}`,
              body: { visibility: 3 },
            },
            {
              method: 'PATCH',
              url: `/manage/post/${entryId}`,
              body: { visibility: 3 },
            },
            {
              method: 'POST',
              url: `/manage/post/${entryId}`,
              body: { visibility: 3, status: 'publish' },
            },
          ];

          for (const ep of publishEndpoints) {
            try {
              const reqBody = ep.body
                ? JSON.stringify({ ...ep.body, title, content })
                : JSON.stringify({ title, content, visibility: 3 });

              const res = await fetch(ep.url, {
                method: ep.method,
                headers: { 'Content-Type': 'application/json' },
                body: reqBody,
                credentials: 'include',
              });
              const text = await res.text();
              log.push({
                ep: `${ep.method} ${ep.url}`,
                status: res.status,
                body: text.substring(0, 300),
              });

              if (res.ok) {
                try {
                  const data = JSON.parse(text);
                  const url =
                    data.url ||
                    data.postUrl ||
                    data.link ||
                    data.publishedUrl ||
                    null;
                  return { success: true, entryId, url, log };
                } catch {
                  // 200이지만 JSON 아님 → 성공으로 간주
                  return { success: true, entryId, url: null, log };
                }
              }
            } catch (e) {
              log.push({
                ep: `${ep.method} ${ep.url}`,
                status: -1,
                body: String(e),
              });
            }
          }

          return { success: false, entryId, log };
        },
        { title, content: publishContent },
      );

      this.logger.log(
        `[6B] autosave 결과: ${JSON.stringify(autosaveResult).substring(0, 1500)}`,
      );

      if (
        autosaveResult.success &&
        typeof autosaveResult === 'object' &&
        'entryId' in autosaveResult
      ) {
        this.logger.log(
          `[6B] autosave 기반 발행 성공! entryId=${(autosaveResult as any).entryId}`,
        );
        const finalCookies = await context.cookies();
        await this.siteRepository.update(site.id, {
          sessionCookies: JSON.stringify(finalCookies),
        });
        const resultUrl =
          (autosaveResult as any).url ||
          `${site.siteUrl.replace(/\/$/, '')}/${(autosaveResult as any).entryId}`;
        return { success: true, publishedUrl: resultUrl };
      }

      // ── 6C. UI 접근법: dkaptcha를 가로막지 않고 자연 로딩 후 postMessage 시뮬레이션 ──
      this.logger.log(
        'Step 6C: dkaptcha 자연 로딩 + UI 발행 + postMessage 시뮬레이션...',
      );

      // 모든 POST 요청 캡처 (실제 발행 엔드포인트 디스커버리)
      const capturedRequests: Array<{
        url: string;
        method: string;
        postData: string | null;
      }> = [];
      page.on('request', (req) => {
        if (
          req.method() === 'POST' ||
          req.method() === 'PUT' ||
          req.method() === 'PATCH'
        ) {
          capturedRequests.push({
            url: req.url(),
            method: req.method(),
            postData: req.postData()?.substring(0, 500) || null,
          });
        }
      });

      // dkaptcha 응답 캡처 (실제 응답 포맷 파악)
      const capturedDkaptchaResponses: Array<{
        url: string;
        status: number;
        body: string;
      }> = [];
      page.on('response', async (res) => {
        if (res.url().includes('dkaptcha')) {
          try {
            const text = await res.text();
            capturedDkaptchaResponses.push({
              url: res.url(),
              status: res.status(),
              body: text.substring(0, 500),
            });
          } catch {
            /* ignore */
          }
        }
      });

      // MutationObserver + postMessage 주입: CAPTCHA iframe 감지 후 widgetId 추출 및 성공 시뮬레이션
      await page.evaluate(() => {
        const w = window as any;
        w.__captchaWidgetIds = w.__captchaWidgetIds || [];
        w.__captchaBypassAttempts = 0;

        const trySendSuccess = (widgetId: string) => {
          w.__captchaBypassAttempts += 1;

          // 다양한 postMessage 포맷 시도
          const formats = [
            { source: 'dkaptcha', event: 'success', widgetId, token: widgetId },
            {
              type: 'dkaptcha',
              status: 'success',
              widgetId,
              data: { token: widgetId },
            },
            { action: 'captcha_success', widgetId, result: 'success' },
            { name: 'dkaptcha', message: 'success', id: widgetId },
            { dkaptcha: true, widgetId, verified: true, token: widgetId },
          ];

          for (const fmt of formats) {
            window.postMessage(fmt, '*');
          }
        };

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of Array.from(mutation.addedNodes)) {
              if (!(node instanceof HTMLElement)) continue;

              const allIframes: HTMLIFrameElement[] = [];
              if (node.tagName === 'IFRAME') {
                allIframes.push(node as HTMLIFrameElement);
              }
              node
                .querySelectorAll?.('iframe')
                .forEach((f) => allIframes.push(f as HTMLIFrameElement));

              for (const iframe of allIframes) {
                const src = iframe.src || iframe.getAttribute('src') || '';
                if (!src.includes('dkaptcha')) continue;

                // widgetId를 src에서 추출
                const widgetMatch = src.match(/[?&]widgetId=([^&]+)/);
                const widgetId = widgetMatch
                  ? widgetMatch[1]
                  : 'wid_' + Date.now();

                w.__captchaWidgetIds.push({ widgetId, src });

                // 즉시 + 지연 시도 (여러 타이밍)
                trySendSuccess(widgetId);
                setTimeout(() => trySendSuccess(widgetId), 500);
                setTimeout(() => trySendSuccess(widgetId), 1000);
                setTimeout(() => trySendSuccess(widgetId), 2000);
                setTimeout(() => trySendSuccess(widgetId), 3500);
              }
            }
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        w.__captchaObserver = observer;
      });

      // "완료" 버튼 클릭 → 발행 레이어 열기
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

      // "공개" 라디오 버튼 선택
      const publicSelected = await page.evaluate(() => {
        const radios = document.querySelectorAll<HTMLInputElement>(
          'input[type="radio"]',
        );
        for (const radio of radios) {
          const container = radio.closest('div, span, label, li');
          const text = container?.textContent?.trim() || '';
          if (text === '공개') {
            radio.click();
            return 'exact';
          }
        }
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
      }
      await page.waitForTimeout(1000);

      // "공개 발행" 버튼 클릭
      const publishResult = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (
            btn.textContent?.trim() === '공개 발행' &&
            btn.offsetParent !== null
          ) {
            btn.click();
            return '공개 발행';
          }
        }
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

      // CAPTCHA + postMessage 작동 대기 (10초)
      await page.waitForTimeout(10000);

      // CAPTCHA iframe에서 실제로 감지된 widgetId 로깅
      const captchaState = await page.evaluate(() => {
        const w = window as any;
        return {
          widgetIds: w.__captchaWidgetIds || [],
          bypassAttempts: w.__captchaBypassAttempts || 0,
        };
      });
      this.logger.log(
        `[6C] CAPTCHA 상태: widgetIds=${JSON.stringify(captchaState.widgetIds)}, bypassAttempts=${captchaState.bypassAttempts}`,
      );

      // dkaptcha 응답 로깅
      this.logger.log(
        `[6C] dkaptcha 응답(${capturedDkaptchaResponses.length}건): ${JSON.stringify(capturedDkaptchaResponses).substring(0, 1000)}`,
      );

      // 캡처된 모든 네트워크 요청 로깅
      this.logger.log(
        `[6C] 캡처된 POST/PUT/PATCH 요청(${capturedRequests.length}건): ${JSON.stringify(capturedRequests).substring(0, 1500)}`,
      );

      // ── 결과 검증 ──

      // 발행 후 쿠키 저장
      const finalCookies = await context.cookies();
      await this.siteRepository.update(site.id, {
        sessionCookies: JSON.stringify(finalCookies),
      });

      const publishedUrl = page.url();
      this.logger.log(`발행 후 URL: ${publishedUrl}`);

      // 캡처된 요청 중 실제 발행 POST가 있으면 성공 판단
      const hasPublishPost = capturedRequests.some(
        (r) =>
          r.url.includes('/manage/') &&
          !r.url.includes('autosave') &&
          !r.url.includes('dkaptcha') &&
          r.postData !== null,
      );
      if (hasPublishPost) {
        const publishReq = capturedRequests.find(
          (r) =>
            r.url.includes('/manage/') &&
            !r.url.includes('autosave') &&
            !r.url.includes('dkaptcha'),
        );
        this.logger.log(
          `발행 POST 요청 캡처됨 (${publishReq?.method} ${publishReq?.url}) → 성공으로 판단`,
        );
        return { success: true, publishedUrl };
      }

      // 글쓰기 페이지에 여전히 머물러 있으면 발행 실패
      if (
        publishedUrl.includes('/manage/newpost') ||
        publishedUrl.includes('accounts.kakao.com') ||
        publishedUrl.includes('tistory.com/auth/login')
      ) {
        const diagnosis = await page.evaluate(() => {
          const result: string[] = [];
          document.querySelectorAll('iframe').forEach((f) => {
            const src = f.src || f.getAttribute('src') || '';
            if (src) result.push(`iframe: ${src.substring(0, 150)}`);
          });
          const captchaEl = document.querySelector(
            '[class*="captcha"], [id*="captcha"], [class*="dkaptcha"]',
          );
          if (captchaEl)
            result.push(`CAPTCHA요소: ${captchaEl.className || captchaEl.id}`);
          const buttons = document.querySelectorAll('button');
          const btnTexts: string[] = [];
          buttons.forEach((btn) => {
            const t = btn.textContent?.trim();
            if (t && (btn as HTMLElement).offsetParent !== null) {
              btnTexts.push(`${t}(disabled=${btn.disabled})`);
            }
          });
          result.push(`buttons: [${btnTexts.join('|')}]`);
          // 저장중 텍스트 확인
          const savingEl = document.querySelector(
            '[class*="saving"], [class*="저장"]',
          );
          if (savingEl)
            result.push(`saving요소: ${savingEl.textContent?.trim()}`);
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

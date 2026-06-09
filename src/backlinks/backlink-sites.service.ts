import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull, LessThan } from 'typeorm';
import {
  Browser,
  BrowserContext,
  Page,
  Frame,
  chromium,
} from 'playwright-core';

import { resolveChromiumPath } from '../common/utils/chromium-path.util';
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
export class BacklinkSitesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BacklinkSitesService.name);
  private proxyIndex = 0;
  private isRecoveringPendingPosts = false;
  private readonly pendingRetryAfterMs = 90 * 60 * 1000;
  private readonly pendingExpireAfterMs = 24 * 60 * 60 * 1000;
  private readonly processingExpireAfterMs = 60 * 60 * 1000;
  private readonly singlePublishTimeoutMs = 20 * 60 * 1000;
  private readonly processingStartedMarker = 'PROCESSING_STARTED_AT=';
  private readonly activePostIds = new Set<string>();
  private publishMutex = Promise.resolve(); // 글 단위 발행 직렬화

  constructor(
    @InjectRepository(AuthoritySite)
    private readonly siteRepository: Repository<AuthoritySite>,
    @InjectRepository(BacklinkPost)
    private readonly postRepository: Repository<BacklinkPost>,
  ) {}

  onApplicationBootstrap(): void {
    setTimeout(() => {
      this.reconcilePendingPosts().catch((err) =>
        this.logger.error(
          `Pending backlink post reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, 10000);
  }

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
    const posts = await this.postRepository.find({
      where: { userId },
      relations: ['authoritySite'],
      order: { createdAt: 'DESC' },
    });

    return posts.map((post) => this.sanitizePostForResponse(post));
  }

  @Cron('*/10 * * * *')
  async reconcilePendingPosts(): Promise<void> {
    if (this.isRecoveringPendingPosts) {
      return;
    }

    this.isRecoveringPendingPosts = true;

    try {
      const now = Date.now();
      const retryBefore = new Date(now - this.pendingRetryAfterMs);
      const expireBefore = new Date(now - this.pendingExpireAfterMs);

      const expiredPending = (
        await this.postRepository.find({
          where: {
            status: PostStatus.PENDING,
            createdAt: LessThan(expireBefore),
          },
        })
      ).filter((post) => !this.activePostIds.has(post.id));

      if (expiredPending.length > 0) {
        await Promise.all(
          expiredPending.map((post) =>
            this.postRepository.update(post.id, {
              status: PostStatus.TIMED_OUT,
              errorMessage:
                '발행 작업이 시작되지 못한 채 오래 대기했습니다. 실제 발행 여부를 확인해주세요.',
            }),
          ),
        );
        this.logger.warn(
          `Marked ${expiredPending.length} stale pending backlink post(s) as TIMED_OUT.`,
        );
      }

      const processingPosts = (
        await this.postRepository.find({
          where: { status: PostStatus.PROCESSING },
        })
      ).filter((post) => !this.activePostIds.has(post.id));

      const expiredProcessing = processingPosts.filter((post) => {
        const startedAt = this.getProcessingStartedAt(post);
        return now - startedAt.getTime() > this.processingExpireAfterMs;
      });

      if (expiredProcessing.length > 0) {
        await Promise.all(
          expiredProcessing.map((post) =>
            this.postRepository.update(post.id, {
              status: PostStatus.TIMED_OUT,
              errorMessage:
                '발행 처리가 제한 시간을 초과했습니다. 중복 발행 방지를 위해 자동 재시도하지 않았습니다. 실제 발행 여부를 확인해주세요.',
            }),
          ),
        );
        this.logger.warn(
          `Marked ${expiredProcessing.length} stale processing backlink post(s) as TIMED_OUT.`,
        );
      }

      const recoverable = (
        await this.postRepository.find({
          where: {
            status: PostStatus.PENDING,
            createdAt: LessThan(retryBefore),
          },
          relations: ['authoritySite'],
          order: { createdAt: 'ASC' },
          take: 20,
        })
      ).filter((post) => !this.activePostIds.has(post.id));

      const postsToRecover = recoverable.filter(
        (post) =>
          post.createdAt.getTime() >= expireBefore.getTime() &&
          post.authoritySite,
      );

      if (postsToRecover.length === 0) {
        return;
      }

      this.logger.warn(
        `Recovering ${postsToRecover.length} pending backlink post(s).`,
      );

      for (const post of postsToRecover) {
        const current = await this.postRepository.findOne({
          where: { id: post.id },
        });

        if (!current || current.status !== PostStatus.PENDING) {
          continue;
        }

        await this.executeAndUpdatePost(
          post.authoritySite,
          current,
          post.title,
          post.body,
        );
      }
    } finally {
      this.isRecoveringPendingPosts = false;
    }
  }

  // ── 쿠키 Keep-Alive (12시간마다) ──

  /**
   * 모든 티스토리 사이트의 세션 쿠키를 주기적으로 갱신한다.
   * 저장된 쿠키로 블로그에 접속 → 세션 연장 → 갱신된 쿠키 저장.
   * 세션 만료된 사이트는 경고 로그만 남기고 스킵한다.
   */
  @Cron('0 */12 * * *') // 매 12시간 (00:00, 12:00)
  async refreshTistoryCookies(): Promise<void> {
    const sites = await this.siteRepository.find({
      where: {
        siteType: SiteType.TISTORY,
        sessionCookies: Not(IsNull()),
      },
    });

    if (sites.length === 0) return;

    this.logger.log(
      `[쿠키 Keep-Alive] 티스토리 ${sites.length}개 사이트 쿠키 갱신 시작`,
    );

    for (const site of sites) {
      let browser: Browser | null = null;
      let context: BrowserContext | null = null;

      try {
        const blogName =
          (site.siteUrl.match(/https?:\/\/([^.]+)\.tistory\.com/) || [])[1] ||
          '';
        if (!blogName) {
          this.logger.warn(
            `[쿠키 Keep-Alive] ${site.siteName}: 블로그명 파싱 실패 (${site.siteUrl})`,
          );
          continue;
        }

        browser = await this.createBrowser({
          useResidentialProxy: true,
          siteKey: site.id,
        });
        context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          locale: 'ko-KR',
          timezoneId: 'Asia/Seoul',
          ignoreHTTPSErrors: true,
        });

        // 저장된 쿠키 복원
        const cookies = JSON.parse(site.sessionCookies!);
        await context.addCookies(cookies);

        const page = await context.newPage();

        // 블로그 관리 페이지 방문 (세션 갱신)
        await page.goto(`https://${blogName}.tistory.com/manage/`, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        await page.waitForTimeout(3000);

        const currentUrl = page.url();

        // 로그인 페이지로 리다이렉트되면 세션 만료
        if (
          currentUrl.includes('tistory.com/auth/login') ||
          currentUrl.includes('accounts.kakao.com')
        ) {
          this.logger.warn(
            `[쿠키 Keep-Alive] ${site.siteName}: 세션 만료됨 – 수동 쿠키 갱신 필요`,
          );
          continue;
        }

        // 갱신된 쿠키 저장
        const freshCookies = await context.cookies();
        await this.siteRepository.update(site.id, {
          sessionCookies: JSON.stringify(freshCookies),
        });

        this.logger.log(
          `[쿠키 Keep-Alive] ${site.siteName}: 쿠키 갱신 완료 (${freshCookies.length}개)`,
        );
      } catch (err) {
        this.logger.error(
          `[쿠키 Keep-Alive] ${site.siteName}: 에러 – ${err instanceof Error ? err.message : String(err)}`,
        );
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

      // 사이트 간 딜레이 (프록시 rate limit 방지)
      await new Promise((r) => setTimeout(r, 5000));
    }

    this.logger.log(`[쿠키 Keep-Alive] 전체 갱신 완료`);
  }

  // ── 글 발행 (백그라운드) ──

  /**
   * PENDING 레코드를 먼저 생성 → 즉시 반환 → 백그라운드에서 실제 발행.
   * 프론트엔드가 새로고침해도 발행이 중단되지 않는다.
   */
  async startPublish(
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

    // 1) 모든 사이트에 대해 PENDING 레코드를 미리 생성
    const pendingPosts: BacklinkPost[] = [];
    for (const site of sites) {
      const post = this.postRepository.create({
        authoritySiteId: site.id,
        title,
        body,
        status: PostStatus.PENDING,
        userId,
      });
      pendingPosts.push(await this.postRepository.save(post));
    }

    for (const post of pendingPosts) {
      this.activePostIds.add(post.id);
    }

    // 2) 백그라운드에서 실제 발행 시작 (뮤텍스로 글 단위 직렬화)
    const postMap = new Map<string, BacklinkPost>();
    for (const post of pendingPosts) {
      postMap.set(post.authoritySiteId, post);
    }

    // 이전 발행이 끝날 때까지 대기 후 실행 (글 단위 직렬화)
    this.publishMutex = this.publishMutex
      .then(
        () => this.processPublishInBackground(sites, postMap, title, body),
        () => this.processPublishInBackground(sites, postMap, title, body),
      )
      .catch((err) => {
        this.logger.error('백그라운드 발행 중 예외 발생', err);
        return this.markUnfinishedPostsFailed(
          postMap,
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        for (const post of pendingPosts) {
          this.activePostIds.delete(post.id);
        }
      });

    // 3) PENDING 레코드를 즉시 반환 (HTTP 응답 즉시 완료)
    return pendingPosts;
  }

  /** 백그라운드 발행 처리 (HTTP 연결과 무관하게 동작) */
  private async processPublishInBackground(
    sites: AuthoritySite[],
    postMap: Map<string, BacklinkPost>,
    title: string,
    body: string,
  ): Promise<void> {
    // 타입별 4그룹 분류
    const wpApiSites = sites.filter(
      (s) => s.siteType === SiteType.WORDPRESS && s.wordpressApiUrl,
    );
    const wpPlaywrightSites = sites.filter(
      (s) => s.siteType === SiteType.WORDPRESS && !s.wordpressApiUrl,
    );
    const tistorySites = sites.filter((s) => s.siteType === SiteType.TISTORY);
    const otherSites = sites.filter(
      (s) =>
        s.siteType !== SiteType.WORDPRESS && s.siteType !== SiteType.TISTORY,
    );

    // 1) WordPress REST API – 전부 즉시 병렬 (브라우저 불필요)
    if (wpApiSites.length > 0) {
      this.logger.log(
        `WordPress API ${wpApiSites.length}개 사이트 병렬 발행 시작`,
      );
      await Promise.all(
        wpApiSites.map((site) =>
          this.executeAndUpdatePost(site, postMap.get(site.id)!, title, body),
        ),
      );
    }

    // 2) WordPress Playwright – 2개씩 배치 (브라우저 리소스 제한)
    if (wpPlaywrightSites.length > 0) {
      this.logger.log(
        `WordPress Playwright ${wpPlaywrightSites.length}개 사이트 발행 시작 (동시 2개)`,
      );
      const WP_CONCURRENCY = 2;
      for (let i = 0; i < wpPlaywrightSites.length; i += WP_CONCURRENCY) {
        if (i > 0) {
          const delay = 5000 + Math.random() * 5000;
          this.logger.log(
            `다음 WordPress 배치까지 ${Math.round(delay / 1000)}초 대기`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const batch = wpPlaywrightSites.slice(i, i + WP_CONCURRENCY);
        await Promise.all(
          batch.map((site) =>
            this.executeAndUpdatePost(site, postMap.get(site.id)!, title, body),
          ),
        );
      }
    }

    // 3) 기타 (LinkedIn, 보리스 등) – 2개씩 배치 (브라우저 리소스 제한)
    if (otherSites.length > 0) {
      this.logger.log(
        `기타 ${otherSites.length}개 사이트 발행 시작 (동시 2개)`,
      );
      const OTHER_CONCURRENCY = 1;
      for (let i = 0; i < otherSites.length; i += OTHER_CONCURRENCY) {
        if (i > 0) {
          const delay = 5000 + Math.random() * 5000;
          this.logger.log(
            `다음 기타 배치까지 ${Math.round(delay / 1000)}초 대기`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const batch = otherSites.slice(i, i + OTHER_CONCURRENCY);
        await Promise.all(
          batch.map((site) =>
            this.executeAndUpdatePost(site, postMap.get(site.id)!, title, body),
          ),
        );
      }
    }

    // 4) 티스토리 – 2개씩 배치 (브라우저 리소스 제한 + CAPTCHA 방지)
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
        await Promise.all(
          batch.map((site) =>
            this.executeAndUpdatePost(site, postMap.get(site.id)!, title, body),
          ),
        );
      }
    }

    this.logger.log('백그라운드 발행 완료');
  }

  /** 단일 사이트 발행 실행 + 기존 PENDING 레코드 업데이트 */
  private async executeAndUpdatePost(
    site: AuthoritySite,
    post: BacklinkPost,
    title: string,
    body: string,
  ): Promise<BacklinkPost> {
    try {
      if (
        post.status !== PostStatus.PENDING &&
        post.status !== PostStatus.PROCESSING
      ) {
        return post;
      }

      post.status = PostStatus.PROCESSING;
      post.errorMessage = `${this.processingStartedMarker}${new Date().toISOString()}`;
      post.publishedUrl = undefined;
      await this.postRepository.save(post);

      const result = await this.withTimeout(
        this.publishToSingleSite(site, title, body),
        this.singlePublishTimeoutMs,
        `${site.siteName} 발행 시간이 ${Math.round(this.singlePublishTimeoutMs / 60000)}분을 초과했습니다.`,
      );
      post.status = result.success ? PostStatus.SUCCESS : PostStatus.FAILED;
      post.publishedUrl = result.publishedUrl ?? undefined;
      post.errorMessage = result.error ?? undefined;
    } catch (err) {
      post.status = PostStatus.FAILED;
      post.errorMessage = err instanceof Error ? err.message : String(err);
    }

    return this.postRepository.save(post);
  }

  private async markUnfinishedPostsFailed(
    postMap: Map<string, BacklinkPost>,
    message: string,
  ): Promise<void> {
    const posts = Array.from(postMap.values());

    await Promise.all(
      posts.map(async (post) => {
        const current = await this.postRepository.findOne({
          where: { id: post.id },
        });

        if (
          !current ||
          (current.status !== PostStatus.PENDING &&
            current.status !== PostStatus.PROCESSING)
        ) {
          return;
        }

        current.status = PostStatus.FAILED;
        current.errorMessage = `백그라운드 발행 작업이 중단되었습니다: ${message}`;
        await this.postRepository.save(current);
      }),
    );
  }

  private getProcessingStartedAt(post: BacklinkPost): Date {
    const raw = post.errorMessage || '';
    if (raw.startsWith(this.processingStartedMarker)) {
      const parsed = new Date(raw.slice(this.processingStartedMarker.length));
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return post.createdAt;
  }

  private sanitizePostForResponse(post: BacklinkPost): BacklinkPost {
    if (post.errorMessage?.startsWith(this.processingStartedMarker)) {
      post.errorMessage = undefined;
    }

    return post;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeout!);
    }
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
      // siteKey로 블로그별 고정 IP 할당 (세션 쿠키 유지를 위해)
      browser = await this.createBrowser({
        useResidentialProxy: true,
        siteKey: site.id,
      });
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
      let dailyLimitHit = false;
      page.on('dialog', async (dialog) => {
        const msg = dialog.message();
        this.logger.log(`다이얼로그 감지: ${dialog.type()} - ${msg}`);
        if (msg.includes('최대') && msg.includes('개까지')) {
          dailyLimitHit = true;
          this.logger.warn('일일 발행 제한 감지 – CAPTCHA 재시도 중단');
        }
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
        this.logger.log(
          `세션 쿠키 없음 – 전체 워밍업 시작 (blog: ${blogName})`,
        );
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

        const loginResult = await this.loginToKakao(
          page,
          site.loginUsername,
          site.loginPassword,
        );

        if (!loginResult.success) {
          return {
            success: false,
            error: loginResult.error,
          };
        }

        // 로그인 후 쿠키 저장
        const cookies = await context.cookies();
        await this.siteRepository.update(site.id, {
          sessionCookies: JSON.stringify(cookies),
        });
        this.logger.log('로그인 성공 – 쿠키 저장 완료');

        // 글쓰기 페이지로 다시 이동
        if (!loginResult.url.includes('/manage/newpost')) {
          await page.goto(writeUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await page.waitForTimeout(3000);
        }

        // 글쓰기 페이지 도달 확인
        const finalUrl = page.url();
        if (
          finalUrl.includes('tistory.com/auth/login') ||
          finalUrl.includes('accounts.kakao.com')
        ) {
          this.logger.error(
            `로그인 후에도 글쓰기 페이지 접근 실패: ${finalUrl}`,
          );
          return {
            success: false,
            error: `로그인은 되었지만 글쓰기 페이지에 접근할 수 없습니다. (URL: ${finalUrl})`,
          };
        }
      }

      // 4. 제목 입력 - 티스토리 에디터 (SPA 렌더링 대기)
      // SPA 클라이언트 리다이렉트 대기 (React 부팅 후 세션 체크 → 로그인 리다이렉트)
      await page.waitForTimeout(3000);
      const preTitleUrl = page.url();
      this.logger.log(`제목 입력 시도 – URL: ${preTitleUrl}`);

      // 2차 로그인 체크: SPA가 부팅 후 로그인 페이지로 리다이렉트한 경우
      if (
        preTitleUrl.includes('tistory.com/auth/login') ||
        preTitleUrl.includes('accounts.kakao.com')
      ) {
        this.logger.log('SPA 리다이렉트 감지 – 카카오 재로그인 시도');
        if (!site.loginUsername || !site.loginPassword) {
          return {
            success: false,
            error: `세션 만료 후 재로그인 실패: 카카오 로그인 정보가 없습니다.`,
          };
        }

        // 카카오 로그인 버튼 클릭
        if (preTitleUrl.includes('tistory.com/auth/login')) {
          const kakaoBtn = await page.$('.btn_login.link_kakao_id');
          if (kakaoBtn) {
            await kakaoBtn.click();
            await page.waitForTimeout(3000);
          }
        }

        // 카카오 로그인 폼
        this.logger.log(`카카오 재로그인 폼 URL: ${page.url()}`);
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

        const loginBtn = await page.$(
          'button[type="submit"], .btn_g.btn_confirm.submit',
        );
        if (loginBtn) {
          await loginBtn.click();
          await page.waitForTimeout(5000);
          this.logger.log(`재로그인 후 URL: ${page.url()}`);
        }

        // 재로그인 성공 확인
        const reLoginUrl = page.url();
        if (
          reLoginUrl.includes('tistory.com/auth/login') ||
          reLoginUrl.includes('accounts.kakao.com')
        ) {
          return {
            success: false,
            error: `카카오 재로그인에 실패했습니다. (URL: ${reLoginUrl})`,
          };
        }

        // 쿠키 갱신
        const freshCookies = await context.cookies();
        await this.siteRepository.update(site.id, {
          sessionCookies: JSON.stringify(freshCookies),
        });
        this.logger.log('재로그인 성공 – 쿠키 갱신 완료');

        // 글쓰기 페이지로 이동
        await page.goto(writeUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(3000);
      }

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

      // CAPTCHA 감지 및 풀이 (최대 10회 시도)
      if (!publishSuccess) {
        for (let attempt = 0; attempt < 10; attempt++) {
          if (dailyLimitHit) {
            this.logger.warn('일일 발행 제한으로 CAPTCHA 시도 중단');
            break;
          }

          const hasCaptcha = await page.evaluate(() => {
            const iframes = document.querySelectorAll('iframe');
            for (const f of iframes) {
              if (f.src?.includes('dkaptcha')) return true;
            }
            return false;
          });

          if (!hasCaptcha) break;

          this.logger.log(
            `dkaptcha CAPTCHA 감지 – AI Vision 풀이 시도 ${attempt + 1}/10`,
          );
          const solved = await this.solveDkaptcha(page);

          if (dailyLimitHit) {
            this.logger.warn('CAPTCHA 풀이 중 일일 발행 제한 감지');
            break;
          }

          if (solved) {
            // 풀이 후 발행 완료 대기 (최대 10초)
            for (let w = 0; w < 10; w++) {
              await page.waitForTimeout(1000);
              if (dailyLimitHit) break;
              if (!page.url().includes('/manage/newpost')) {
                publishSuccess = true;
                this.logger.log(`CAPTCHA 풀이 후 발행 성공: ${page.url()}`);
                break;
              }
            }
            if (publishSuccess || dailyLimitHit) break;
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

      if (dailyLimitHit) {
        this.logger.error(
          `발행 실패 [${site.siteName}]: 하루 공개 발행 제한(15개) 초과`,
        );
        return {
          success: false,
          error: '하루 공개 발행 제한(15개)을 초과했습니다.',
        };
      }

      this.logger.error(
        `발행 실패 [${site.siteName}]: CAPTCHA 자동 풀이 10회 모두 실패`,
      );
      return {
        success: false,
        error: 'dkaptcha CAPTCHA 자동 풀이에 실패했습니다 (10회 시도).',
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

  private async loginToKakao(
    page: Page,
    username: string,
    password: string,
  ): Promise<{ success: boolean; url: string; error?: string }> {
    this.logger.log(`카카오 로그인 폼 URL: ${page.url()}`);
    await page.waitForTimeout(2000);

    try {
      const saveLoginCheckbox = page.getByRole('checkbox', {
        name: /간편로그인 정보 저장|로그인 정보 저장|Save Login/i,
      });
      if (await saveLoginCheckbox.isVisible({ timeout: 1500 })) {
        const checked = await saveLoginCheckbox.isChecked();
        if (!checked) {
          await saveLoginCheckbox.click({ timeout: 3000 });
        }
      }
    } catch {
      // optional checkbox
    }

    const emailEntered = await this.fillFirstVisible(page, [
      {
        roleName: /계정정보 입력|Enter Account Information/i,
        value: username,
      },
      {
        selectors: [
          'input[name="loginId"]',
          'input[name="loginKey"]',
          '#loginId',
          '[id^="loginId"]',
          'input[placeholder*="카카오메일"]',
          'input[placeholder*="이메일"]',
          'input[placeholder*="Account"]',
          'input[type="email"]',
          'input[type="text"]:not([type="hidden"])',
          'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])',
        ],
        value: username,
      },
    ]);

    const passwordEntered = await this.fillFirstVisible(page, [
      {
        roleName: /비밀번호 입력|Enter Pa|Password/i,
        value: password,
      },
      {
        selectors: [
          'input[type="password"]',
          'input[name="password"]',
          '#password',
          '[id^="password"]',
          'input[placeholder*="비밀번호"]',
          'input[placeholder*="Password"]',
        ],
        value: password,
      },
    ]);

    if (!emailEntered || !passwordEntered) {
      return {
        success: false,
        url: page.url(),
        error:
          '카카오 로그인 입력 폼을 찾지 못했습니다. 카카오 로그인 페이지 구조가 변경되었거나 추가 인증 화면이 먼저 표시되었습니다.',
      };
    }

    await page.waitForTimeout(500);

    let loginClicked = false;
    try {
      const loginButton = page.getByRole('button', { name: /Log In|로그인/i });
      if (await loginButton.isVisible({ timeout: 2000 })) {
        await loginButton.click();
        loginClicked = true;
      }
    } catch {
      // fallback below
    }

    if (!loginClicked) {
      const selectors = [
        'button[type="submit"]',
        'button.btn_confirm',
        'button.submit',
        '.btn_g.btn_confirm.submit',
        'input[type="submit"]',
      ];

      for (const selector of selectors) {
        const button = await page.$(selector);
        if (button && (await button.isVisible().catch(() => false))) {
          await button.click();
          loginClicked = true;
          break;
        }
      }
    }

    if (!loginClicked) {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(8000);

    const resultUrl = page.url();
    this.logger.log(`로그인 시도 후 URL: ${resultUrl}`);

    const pageText = (await page.textContent('body').catch(() => '')) || '';
    const errorText = await this.extractVisibleText(page, [
      '.error_message',
      '.txt_error',
      '.login_error',
      '[class*="error"]:not([class*="checkbox"])',
      '[class*="Error"]',
    ]);

    if (this.hasKakaoVerificationChallenge(resultUrl, pageText)) {
      return {
        success: false,
        url: resultUrl,
        error:
          '카카오 2단계 인증 또는 본인 확인이 필요합니다. 브라우저에서 해당 카카오 계정으로 직접 로그인해 보안 확인을 완료한 뒤 다시 시도해주세요.',
      };
    }

    if (errorText) {
      return {
        success: false,
        url: resultUrl,
        error: `카카오 로그인 실패: ${errorText}`,
      };
    }

    if (
      resultUrl.includes('accounts.kakao.com') ||
      resultUrl.includes('tistory.com/auth/login')
    ) {
      return {
        success: false,
        url: resultUrl,
        error:
          '카카오 로그인에 실패했습니다. 계정 정보가 맞더라도 카카오 보안 확인, CAPTCHA, 휴면/잠금 상태, 또는 로그인 차단이 있으면 자동 로그인이 실패합니다.',
      };
    }

    return { success: true, url: resultUrl };
  }

  private async fillFirstVisible(
    page: Page,
    attempts: Array<{
      roleName?: RegExp;
      selectors?: string[];
      value: string;
    }>,
  ): Promise<boolean> {
    for (const attempt of attempts) {
      if (attempt.roleName) {
        try {
          const locator = page.getByRole('textbox', {
            name: attempt.roleName,
          });
          if (await locator.isVisible({ timeout: 1500 })) {
            await locator.click();
            await locator.fill(attempt.value);
            return true;
          }
        } catch {
          // try selectors
        }
      }

      for (const selector of attempt.selectors || []) {
        const element = await page.$(selector);
        if (element && (await element.isVisible().catch(() => false))) {
          await element.click();
          await element.fill(attempt.value);
          return true;
        }
      }
    }

    return false;
  }

  private async extractVisibleText(
    page: Page,
    selectors: string[],
  ): Promise<string | null> {
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (!element || !(await element.isVisible().catch(() => false))) {
        continue;
      }

      const text = (await element.textContent())?.trim();
      if (text && !text.toLowerCase().includes('checkbox')) {
        return text;
      }
    }

    return null;
  }

  private hasKakaoVerificationChallenge(
    url: string,
    pageText: string,
  ): boolean {
    const lowerUrl = url.toLowerCase();
    const indicators = [
      'two-step',
      '2step',
      'twostep',
      'verify',
      'verification',
      'confirm',
      'confirmation',
      'security',
      'authenticate',
      'passcode',
      'otp',
    ];

    if (indicators.some((indicator) => lowerUrl.includes(indicator))) {
      return true;
    }

    const verificationTexts = [
      '본인 확인',
      '본인확인',
      '인증번호',
      '인증 번호',
      '2단계 인증',
      '2차 인증',
      '보안 인증',
      '추가 인증',
      '휴면',
      '잠금',
      'captcha',
      'verification',
      'verify',
    ];

    const lowerText = pageText.toLowerCase();
    return verificationTexts.some((text) =>
      lowerText.includes(text.toLowerCase()),
    );
  }

  /** PROXY_HOSTS에서 사이트별 고정 IP 선택 (같은 siteKey → 같은 IP) */
  private pickProxyForSite(siteKey?: string): {
    host: string;
    port: string;
    username: string;
    password: string;
  } | null {
    const hostsRaw = process.env.PROXY_HOSTS; // "ip1,ip2,ip3,..."
    const proxyUser = process.env.PROXY_USERNAME;
    const proxyPass = process.env.PROXY_PASSWORD;
    const proxyPort = process.env.PROXY_PORT || '50100';

    if (hostsRaw && proxyUser && proxyPass) {
      const hosts = hostsRaw
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      if (hosts.length > 0) {
        let index: number;
        if (siteKey) {
          // siteKey의 해시값으로 고정 인덱스 결정
          let hash = 0;
          for (let i = 0; i < siteKey.length; i++) {
            hash = (hash * 31 + siteKey.charCodeAt(i)) >>> 0;
          }
          index = hash % hosts.length;
        } else {
          index = this.proxyIndex++;
        }
        const host = hosts[index];
        return {
          host,
          port: proxyPort,
          username: proxyUser,
          password: proxyPass,
        };
      }
    }

    // fallback: 단일 PROXY_HOST
    const singleHost = process.env.PROXY_HOST;
    if (singleHost && proxyUser && proxyPass) {
      return {
        host: singleHost,
        port: proxyPort,
        username: proxyUser,
        password: proxyPass,
      };
    }

    return null;
  }

  private async createBrowser(options?: {
    useResidentialProxy?: boolean;
    siteKey?: string;
  }): Promise<Browser> {
    const proxy = options?.useResidentialProxy
      ? this.pickProxyForSite(options.siteKey)
      : null;

    this.logger.log(
      `CloakBrowser 스텔스 브라우저 실행${proxy ? ` (Proxy: ${proxy.host}:${proxy.port})` : ''}`,
    );

    const execPath = resolveChromiumPath();

    const launchOptions: Record<string, unknown> = {
      headless: true,
      executablePath: execPath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
    };

    if (proxy) {
      launchOptions.proxy = {
        server: `http://${proxy.host}:${proxy.port}`,
        username: proxy.username,
        password: proxy.password,
      };
    } else if (options?.useResidentialProxy) {
      this.logger.warn('PROXY_* 환경변수 미설정 – 프록시 없이 실행');
    }

    try {
      const { launch } = await (Function(
        'return import("cloakbrowser")',
      )() as Promise<typeof import('cloakbrowser')>);

      return (await launch(launchOptions)) as unknown as Browser;
    } catch (err) {
      this.logger.warn(
        `CloakBrowser 실행 실패, 기본 Chromium으로 재시도: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      return await chromium.launch(launchOptions);
    } catch (err) {
      this.logger.error(
        `기본 Chromium 실행 실패: ${err instanceof Error ? err.message : String(err)}`,
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
        if (!questionEl)
          return {
            imgSrc,
            parts: [] as { text: string; isBlank: boolean }[],
            fullText: '',
          };

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
      const knownBefore = textBefore.join('').trim();
      const knownAfter = textAfter.join('').trim();
      this.logger.log(
        `퀴즈: 빈칸 ${blankCount}개, 패턴="${knownBefore}[${'□'.repeat(blankCount)}]${knownAfter}"`,
      );

      // 4. CAPTCHA 지도 이미지 획득
      let imgBase64: string | null = null;
      let mediaType: 'image/jpeg' | 'image/png' = 'image/png';

      // 4-1. 브라우저 컨텍스트에서 data-resource 이미지 직접 fetch
      //      (서버 IP 차단 우회: 브라우저의 세션/쿠키로 카카오 CDN 접근)
      if (quizInfo.imgSrc) {
        const imgUrl = quizInfo.imgSrc.startsWith('http')
          ? quizInfo.imgSrc
          : `https://${quizInfo.imgSrc}`;
        this.logger.log(`브라우저 컨텍스트에서 지도 이미지 fetch: ${imgUrl}`);
        try {
          const b64 = await page.evaluate(async (url: string) => {
            try {
              const resp = await fetch(url);
              if (!resp.ok) return null;
              const blob = await resp.blob();
              return new Promise<string | null>((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                  const dataUrl = reader.result as string;
                  resolve(dataUrl); // "data:image/...;base64,..."
                };
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
              });
            } catch {
              return null;
            }
          }, imgUrl);

          if (b64 && b64.startsWith('data:image')) {
            const [header, data] = b64.split(',');
            imgBase64 = data;
            mediaType = header.includes('png') ? 'image/png' : 'image/jpeg';
            this.logger.log(
              `브라우저 fetch 성공 (${mediaType}, ${Math.round((data.length * 0.75) / 1024)}KB)`,
            );
          }
        } catch (e) {
          this.logger.warn(
            `브라우저 fetch 실패: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // 4-2. 브라우저 fetch 실패 시 서버에서 직접 다운로드
      if (!imgBase64 && quizInfo.imgSrc) {
        const imgUrl = quizInfo.imgSrc.startsWith('http')
          ? quizInfo.imgSrc
          : `https://${quizInfo.imgSrc}`;
        this.logger.log(`서버에서 지도 이미지 다운로드: ${imgUrl}`);
        const downloaded = await this.fetchImageAsBase64(imgUrl);
        if (downloaded) {
          imgBase64 = downloaded.base64;
          mediaType = downloaded.mediaType;
          this.logger.log(
            `서버 다운로드 성공 (${downloaded.mediaType}, ${Math.round((downloaded.base64.length * 0.75) / 1024)}KB)`,
          );
        }
      }

      // 4-3. 다운로드 모두 실패 → iframe 내 지도 컨테이너 요소만 스크린샷
      if (!imgBase64) {
        this.logger.warn('이미지 다운로드 실패 – 지도 요소 스크린샷 시도');
        try {
          const mapEl = await dkFrame.$('#container_dkaptcha');
          if (mapEl) {
            const screenshotBuf = await mapEl.screenshot({ type: 'png' });
            imgBase64 = screenshotBuf.toString('base64');
            mediaType = 'image/png';
            this.logger.log(
              `지도 요소 스크린샷 성공 (${Math.round(screenshotBuf.length / 1024)}KB)`,
            );
          }
        } catch (e) {
          this.logger.warn(
            `지도 요소 스크린샷 실패: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // 4-4. 최종 fallback: iframe 전체 스크린샷
      if (!imgBase64) {
        this.logger.warn('지도 요소 스크린샷 실패 – iframe 전체 스크린샷');
        try {
          const iframes = await page.$$('iframe');
          for (const iframe of iframes) {
            const src = (await iframe.getAttribute('src')) || '';
            if (src.includes('dkaptcha')) {
              const screenshotBuf = await iframe.screenshot({ type: 'png' });
              imgBase64 = screenshotBuf.toString('base64');
              mediaType = 'image/png';
              break;
            }
          }
        } catch {
          /* ignore */
        }
      }

      if (!imgBase64) {
        this.logger.warn('모든 이미지 획득 방법 실패');
        return false;
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
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
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
                  text: `카카오맵 CAPTCHA입니다. 지도 중앙의 빨간 마커(핀)가 가리키는 장소명을 읽으세요.

패턴: "${pattern}" (□=${blankCount}글자 빈칸)
"${knownBefore}" + 정답(${blankCount}글자) + "${knownAfter}" = 마커가 가리키는 장소명

지도에 보이는 모든 장소명을 나열한 뒤, 마커 위치의 장소명에서 빈칸에 해당하는 ${blankCount}글자를 찾으세요.
검증: "${knownBefore}" + 정답 + "${knownAfter}"를 합쳐서 지도에 적힌 장소명과 완전히 일치해야 합니다.

반드시 아래 형식으로만 답하세요:
PLACES: 장소1, 장소2, 장소3, ...
MATCH: 전체장소명
ANSWER: ${blankCount}글자정답`,
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

      // 1차 응답에서 정답 추출
      const candidate = this.extractAnswer(
        raw,
        knownBefore,
        knownAfter,
        blankCount,
      );
      if (candidate) return candidate;

      // 글자수 불일치 시 – MATCH에서 찾은 장소명을 힌트로 2차 집중 질문
      const matchLine = raw.match(/MATCH:\s*(.+)/i);
      const firstMatchName = matchLine ? this.stripNoise(matchLine[1]) : null;

      if (firstMatchName) {
        this.logger.log(
          `1차 답 실패, "${firstMatchName}" 주변 재검사 (${blankCount}글자 필요)`,
        );
        const retryAnswer = await this.retryClaudeVision(
          imgBase64,
          mediaType,
          knownBefore,
          knownAfter,
          blankCount,
          firstMatchName,
        );
        if (retryAnswer) return retryAnswer;
      }

      return null;
    } catch (err) {
      this.logger.error(
        `Claude Vision 호출 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** 1차 응답에서 ANSWER/MATCH/마지막줄 순으로 정답 추출 */
  /** 응답 텍스트에서 불필요한 기호만 제거 (한글/영문/숫자 유지) */
  private stripNoise(text: string): string {
    return text.replace(/[^가-힣a-zA-Z0-9]/g, '');
  }

  private extractAnswer(
    raw: string,
    knownBefore: string,
    knownAfter: string,
    blankCount: number,
  ): string | null {
    // ANSWER: 라인
    const answerMatch = raw.match(/ANSWER:\s*(.+)/i);
    if (answerMatch) {
      const cleaned = this.stripNoise(answerMatch[1]);
      if (cleaned.length === blankCount) return cleaned;
      this.logger.warn(
        `ANSWER 글자수 불일치: "${cleaned}" (${cleaned.length}글자, 필요: ${blankCount})`,
      );
    }

    // MATCH: 라인에서 패턴 매칭
    const matchLine = raw.match(/MATCH:\s*(.+)/i);
    if (matchLine) {
      const matchedName = this.stripNoise(matchLine[1]);
      if (
        matchedName.startsWith(knownBefore) &&
        matchedName.endsWith(knownAfter)
      ) {
        const afterLen = knownAfter.length || 0;
        const extracted =
          afterLen > 0
            ? matchedName.slice(knownBefore.length, -afterLen)
            : matchedName.slice(knownBefore.length);
        if (extracted.length === blankCount) {
          this.logger.log(
            `MATCH에서 정답 추출: "${matchedName}" → "${extracted}"`,
          );
          return extracted;
        }
      }
    }

    // PLACES에서 패턴 매칭 시도 (MATCH 실패 시 대비)
    const placesMatch = raw.match(/PLACES:\s*(.+)/i);
    if (placesMatch) {
      const places = placesMatch[1]
        .split(/[,\[\]]+/)
        .map((s: string) => this.stripNoise(s))
        .filter(Boolean);
      for (const place of places) {
        if (
          place.startsWith(knownBefore) &&
          (!knownAfter || place.endsWith(knownAfter))
        ) {
          const afterLen = knownAfter.length || 0;
          const extracted =
            afterLen > 0
              ? place.slice(knownBefore.length, -afterLen)
              : place.slice(knownBefore.length);
          if (extracted.length === blankCount) {
            this.logger.log(
              `PLACES에서 정답 추출: "${place}" → "${extracted}"`,
            );
            return extracted;
          }
        }
      }
    }

    // 마지막 줄에서 추출
    const lines = raw.split('\n').filter((l: string) => l.trim());
    const lastLine = lines[lines.length - 1] || '';
    const cleaned = this.stripNoise(lastLine);
    if (cleaned.length === blankCount) return cleaned;

    return null;
  }

  /** 2차 집중 질문: 1차에서 찾은 장소명 주변을 더 정밀하게 다시 읽기 */
  private async retryClaudeVision(
    imgBase64: string,
    mediaType: 'image/jpeg' | 'image/png',
    knownBefore: string,
    knownAfter: string,
    blankCount: number,
    firstMatchName: string,
  ): Promise<string | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

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
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
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
                  text: `이전에 이 지도에서 "${firstMatchName}"을 찾았지만, 정답은 정확히 ${blankCount}글자여야 합니다.

패턴: "${pattern}" (□ = 빈칸 1글자, 총 ${blankCount}글자)

"${firstMatchName}" 주변을 다시 매우 주의 깊게 보세요.
- 글자가 겹쳐 보이거나 작아서 놓친 글자가 있을 수 있습니다.
- "${knownAfter}" 바로 앞에 있는 글자들을 한 글자씩 천천히 읽으세요.
- 정답은 반드시 ${blankCount}개의 한글 글자입니다.

ANSWER: [정확히 ${blankCount}글자만]`,
                },
              ],
            },
          ],
        }),
      });

      if (!resp.ok) return null;

      const data = await resp.json();
      const raw = data?.content?.[0]?.text?.trim() || '';
      this.logger.log(`2차 재검사 응답: ${raw.substring(0, 200)}`);

      // ANSWER 추출
      const answerMatch = raw.match(/ANSWER:\s*(.+)/i);
      if (answerMatch) {
        const cleaned = this.stripNoise(answerMatch[1]);
        if (cleaned.length === blankCount) {
          this.logger.log(`2차 재검사 성공: "${cleaned}"`);
          return cleaned;
        }
      }

      // MATCH에서 패턴 매칭 시도
      const matchLine = raw.match(/MATCH:\s*(.+)/i);
      if (matchLine) {
        const matchedName = this.stripNoise(matchLine[1]);
        if (
          matchedName.startsWith(knownBefore) &&
          (knownAfter === '' || matchedName.endsWith(knownAfter))
        ) {
          const afterLen = knownAfter.length || 0;
          const extracted =
            afterLen > 0
              ? matchedName.slice(knownBefore.length, -afterLen)
              : matchedName.slice(knownBefore.length);
          if (extracted.length === blankCount) {
            this.logger.log(
              `2차 MATCH 추출 성공: "${matchedName}" → "${extracted}"`,
            );
            return extracted;
          }
        }
      }

      return null;
    } catch (err) {
      this.logger.error(
        `2차 재검사 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // ── 수동 카카오 인증 (쿠키 저장 / 세션 검증) ──

  /**
   * 사용자가 브라우저에서 직접 복사한 쿠키를 저장한다.
   * JSON 배열, key=value 문자열, Chrome DevTools 탭 구분 형식을 모두 지원.
   */
  async saveCookies(
    id: string,
    userId: string,
    rawCookies: string,
  ): Promise<{ success: boolean; message: string }> {
    const site = await this.siteRepository.findOne({ where: { id, userId } });
    if (!site) throw new NotFoundException('사이트를 찾을 수 없습니다.');

    const trimmed = rawCookies.trim();
    if (!trimmed) {
      return { success: false, message: '쿠키 값이 비어있습니다.' };
    }

    let normalizedCookies: string;

    // 1) JSON 배열 형식 (Playwright 쿠키 / EditThisCookie 등)
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return { success: false, message: '유효한 쿠키 배열이 아닙니다.' };
        }
        // Playwright 형식이면 그대로, 아니면 변환
        const hasName = parsed.every(
          (c: Record<string, unknown>) => typeof c.name === 'string',
        );
        if (!hasName) {
          return {
            success: false,
            message: '각 쿠키 객체에 name 필드가 필요합니다.',
          };
        }
        normalizedCookies = JSON.stringify(parsed);
      } catch {
        return { success: false, message: '쿠키 JSON 파싱에 실패했습니다.' };
      }
    }
    // 2) Chrome DevTools 탭 구분 형식
    else if (trimmed.includes('\t')) {
      const domain = '.tistory.com';
      const lines = trimmed.split('\n').filter((line) => line.trim());
      const cookies: Array<Record<string, unknown>> = [];

      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const name = parts[0].trim();
          const value = parts[1].trim();
          if (name && name.toLowerCase() !== 'name') {
            cookies.push({ name, value, domain, path: '/' });
          }
        }
      }

      if (cookies.length === 0) {
        return { success: false, message: '유효한 쿠키를 찾을 수 없습니다.' };
      }
      normalizedCookies = JSON.stringify(cookies);
    }
    // 3) key=value; key=value 문자열 형식
    else {
      const blogHostname = new URL(site.siteUrl).hostname;
      const domain = blogHostname.includes('tistory.com')
        ? '.tistory.com'
        : blogHostname;

      const cookies = trimmed
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

      if (cookies.length === 0) {
        return { success: false, message: '유효한 쿠키를 찾을 수 없습니다.' };
      }
      normalizedCookies = JSON.stringify(cookies);
    }

    await this.siteRepository.update(id, {
      sessionCookies: normalizedCookies,
    });

    return {
      success: true,
      message: `쿠키가 저장되었습니다 (${JSON.parse(normalizedCookies).length}개).`,
    };
  }

  /**
   * 저장된 세션 쿠키가 유효한지 티스토리 관리 페이지 접근으로 검증한다.
   */
  async verifySession(
    id: string,
    userId: string,
  ): Promise<{ valid: boolean; message: string }> {
    const site = await this.siteRepository.findOne({ where: { id, userId } });
    if (!site) throw new NotFoundException('사이트를 찾을 수 없습니다.');

    if (!site.sessionCookies) {
      return { valid: false, message: '저장된 세션 쿠키가 없습니다.' };
    }

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      const blogName =
        (site.siteUrl.match(/https?:\/\/([^.]+)\.tistory\.com/) || [])[1] || '';
      if (!blogName) {
        return {
          valid: false,
          message: '블로그 URL에서 블로그명을 파싱할 수 없습니다.',
        };
      }

      browser = await this.createBrowser({
        useResidentialProxy: true,
        siteKey: site.id,
      });
      context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
        ignoreHTTPSErrors: true,
      });

      const cookies = JSON.parse(site.sessionCookies);
      await context.addCookies(cookies);

      const page = await context.newPage();
      await page.goto(`https://${blogName}.tistory.com/manage/`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.waitForTimeout(3000);

      const currentUrl = page.url();

      if (
        currentUrl.includes('tistory.com/auth/login') ||
        currentUrl.includes('accounts.kakao.com')
      ) {
        return {
          valid: false,
          message:
            '세션이 만료되었습니다. 카카오 로그인 후 쿠키를 다시 저장해주세요.',
        };
      }

      // 쿠키 갱신 (방문으로 세션 연장됨)
      const freshCookies = await context.cookies();
      await this.siteRepository.update(site.id, {
        sessionCookies: JSON.stringify(freshCookies),
      });

      return {
        valid: true,
        message: '세션이 유효합니다. 정상적으로 발행할 수 있습니다.',
      };
    } catch (err) {
      return {
        valid: false,
        message: `세션 검증 중 오류: ${err instanceof Error ? err.message : String(err)}`,
      };
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

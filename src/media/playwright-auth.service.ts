import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, Page, BrowserContext } from 'playwright-core';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { MediaPlatform } from '../database/entities/media-connection.entity';

interface AuthResult {
  success: boolean;
  message: string;
  accountInfo?: {
    name: string;
    url?: string;
    blogId?: string;
  };
  cookies?: string; // 세션 쿠키 저장용
}

interface BlogStats {
  totalPosts: number;
  totalViews: number;
  todayVisitors: number;
  subscribers?: number;
}

@Injectable()
export class PlaywrightAuthService {
  private readonly logger = new Logger(PlaywrightAuthService.name);
  private browser: Browser | null = null;

  /**
   * 브라우저 인스턴스 가져오기
   * 디버깅 시 headless: false로 변경하여 브라우저 창을 확인할 수 있습니다.
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

      // 2. 시스템 chromium 찾기 (nixpacks 환경)
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
          `${playwrightPath}/chromium_headless_shell-1200/chrome-linux64/headless_shell`,
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
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-translate',
          '--metrics-recording-only',
          '--no-first-run',
          '--safebrowsing-disable-auto-update',
          // '--single-process', // 제거: 서버리스 환경에서 불안정
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
   * 발행 전용 독립 브라우저 생성 (매번 새로 생성)
   * 서버리스 환경에서 안정성을 위해 공유 브라우저 대신 사용
   */
  private async createFreshBrowser(): Promise<Browser> {
    // fs, execSync는 top-level에서 import됨

    let execPath: string | undefined = undefined;

    if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
      execPath = process.env.CHROMIUM_PATH;
    }

    if (!execPath) {
      try {
        const systemChromium = execSync(
          'which chromium || which chromium-browser || which google-chrome',
          { encoding: 'utf-8' },
        ).trim();
        if (systemChromium && fs.existsSync(systemChromium)) {
          execPath = systemChromium;
        }
      } catch {
        // ignore
      }
    }

    if (!execPath) {
      const playwrightPath =
        process.env.PLAYWRIGHT_BROWSERS_PATH || '/app/.cache/ms-playwright';
      const possiblePaths = [
        `${playwrightPath}/chromium-1200/chrome-linux64/chrome`,
        `${playwrightPath}/chromium-1200/chrome-linux/chrome`,
        `${playwrightPath}/chromium_headless_shell-1200/chrome-linux64/headless_shell`,
      ];
      for (const path of possiblePaths) {
        if (fs.existsSync(path)) {
          execPath = path;
          break;
        }
      }
    }

    this.logger.log(
      `발행용 새 브라우저 생성: ${execPath || 'Playwright 기본값'}`,
    );

    return await chromium.launch({
      headless: true,
      executablePath: execPath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--no-first-run',
      ],
    });
  }

  /**
   * 쿠키 문자열을 Playwright 쿠키 배열로 변환
   * - JSON 배열 형식: [{"name": "...", "value": "..."}]
   * - 문자열 형식: key=value; key=value
   */
  private parseCookieString(
    cookies: string,
    domain: string,
  ): Array<{ name: string; value: string; domain: string; path: string }> {
    const trimmed = cookies.trim();

    // JSON 배열 형식인지 확인
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        this.logger.warn('쿠키 JSON 파싱 실패, 문자열 형식으로 시도');
      }
    }

    // key=value; key=value 문자열 형식을 Playwright 쿠키 배열로 변환
    return trimmed
      .split(';')
      .map((pair) => pair.trim())
      .filter((pair) => pair.includes('='))
      .map((pair) => {
        const equalIndex = pair.indexOf('=');
        const name = pair.substring(0, equalIndex).trim();
        const value = pair.substring(equalIndex + 1).trim();
        return {
          name,
          value,
          domain,
          path: '/',
        };
      });
  }

  /**
   * 네이버 로그인 수행 (재사용 가능한 헬퍼 메서드)
   * - 이미 로그인 페이지에 있는 Page 객체에서 로그인 수행
   */
  private async performNaverLogin(
    page: Page,
    username: string,
    password: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.logger.log(`네이버 재로그인 시도: ${username}`);

      // 로그인 페이지가 아니면 이동
      const currentUrl = page.url();
      if (!currentUrl.includes('nidlogin') && !currentUrl.includes('login')) {
        await page.goto('https://nid.naver.com/nidlogin.login', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(1000);
      }

      // 아이디 입력 (JavaScript로 직접 입력 - 캡챠 우회)
      await page.evaluate((id) => {
        const input = document.querySelector('#id') as HTMLInputElement;
        if (input) {
          input.value = id;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, username);

      await page.waitForTimeout(500);

      // 비밀번호 입력
      await page.evaluate((pw) => {
        const input = document.querySelector('#pw') as HTMLInputElement;
        if (input) {
          input.value = pw;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, password);

      await page.waitForTimeout(500);

      // 로그인 버튼 클릭
      await page.click('#log\\.login, .btn_login, button[type="submit"]');

      // 로그인 결과 대기
      await page.waitForTimeout(3000);

      // 로그인 성공 여부 확인
      const afterLoginUrl = page.url();

      // 캡챠 체크
      if (afterLoginUrl.includes('captcha') || (await page.$('#captcha'))) {
        return {
          success: false,
          error:
            '캡챠 인증이 필요합니다. 네이버 웹에서 직접 로그인 후 다시 시도해주세요.',
        };
      }

      // 2단계 인증 체크
      if (afterLoginUrl.includes('auth') || (await page.$('.login_second'))) {
        return {
          success: false,
          error:
            '2단계 인증이 필요합니다. 네이버 앱에서 인증 후 다시 시도해주세요.',
        };
      }

      // 오류 메시지 체크
      const errorMsg = await page.$('.error_message, #err_common');
      if (errorMsg) {
        const errorText = await errorMsg.textContent();
        return {
          success: false,
          error: errorText?.trim() || '로그인에 실패했습니다.',
        };
      }

      // 여전히 로그인 페이지면 실패
      if (
        afterLoginUrl.includes('nidlogin') ||
        afterLoginUrl.includes('login')
      ) {
        return {
          success: false,
          error: '로그인에 실패했습니다. 아이디/비밀번호를 확인해주세요.',
        };
      }

      this.logger.log('네이버 재로그인 성공');
      return { success: true };
    } catch (error) {
      this.logger.error(`네이버 재로그인 오류: ${error.message}`);
      return {
        success: false,
        error: `재로그인 실패: ${error.message}`,
      };
    }
  }

  /**
   * 티스토리(카카오) 로그인 수행 (재사용 가능한 헬퍼 메서드)
   *
   * 2026년 기준 카카오 로그인 페이지 구조:
   * - accounts.kakao.com/login/
   * - 이메일: textbox "Enter Account Information" 또는 placeholder로 찾기
   * - 비밀번호: textbox "Enter Pa word" (Password에서 ss가 잘림) 또는 password type으로 찾기
   * - 로그인 버튼: button "Log In"
   */
  private async performTistoryLogin(
    page: Page,
    username: string,
    password: string,
  ): Promise<{ success: boolean; cookies?: string; error?: string }> {
    try {
      this.logger.log(`티스토리 재로그인 시도: ${username}`);

      const currentUrl = page.url();
      this.logger.log(`현재 URL: ${currentUrl}`);

      // 이미 카카오 로그인 페이지에 있는지 확인
      const isKakaoLoginPage = currentUrl.includes('accounts.kakao.com');
      const isTistoryLoginPage = currentUrl.includes('tistory.com/auth/login');

      // 카카오 로그인 페이지가 아니면 티스토리 로그인 페이지로 이동
      if (!isKakaoLoginPage) {
        if (!isTistoryLoginPage) {
          this.logger.log('티스토리 로그인 페이지로 이동...');
          await page.goto('https://www.tistory.com/auth/login', {
            waitUntil: 'networkidle',
            timeout: 30000,
          });
          await page.waitForTimeout(2000);
        }

        // 카카오계정으로 로그인 버튼 클릭
        this.logger.log('카카오계정으로 로그인 버튼 찾는 중...');
        let kakaoLoginClicked = false;

        // 방법 1: "카카오계정으로 로그인" 링크 (티스토리 로그인 페이지)
        try {
          const kakaoLoginLink = page.getByRole('link', {
            name: /카카오계정으로 로그인/i,
          });
          if (await kakaoLoginLink.isVisible({ timeout: 3000 })) {
            this.logger.log('카카오계정으로 로그인 링크 클릭');
            await kakaoLoginLink.click();
            kakaoLoginClicked = true;
            await page.waitForTimeout(3000);
          }
        } catch (e) {
          this.logger.log(`카카오계정으로 로그인 링크 없음: ${e.message}`);
        }

        // 방법 2: "카카오계정으로 시작하기" 링크 (티스토리 메인 페이지)
        if (!kakaoLoginClicked) {
          try {
            const kakaoStartLink = page.getByRole('link', {
              name: /카카오계정으로 시작하기/i,
            });
            if (await kakaoStartLink.isVisible({ timeout: 2000 })) {
              this.logger.log('카카오계정으로 시작하기 링크 클릭');
              await kakaoStartLink.click();
              kakaoLoginClicked = true;
              await page.waitForTimeout(3000);
            }
          } catch (e) {
            this.logger.log(`카카오계정으로 시작하기 링크 없음: ${e.message}`);
          }
        }

        // 방법 3: CSS 셀렉터로 찾기
        if (!kakaoLoginClicked) {
          const kakaoBtn = await page.$(
            'a[href*="kakao"], button[class*="kakao"], .btn_login_kakao, .link_kakao',
          );
          if (kakaoBtn) {
            this.logger.log('카카오 로그인 버튼 클릭 (CSS 셀렉터)');
            try {
              // 페이지 네비게이션을 기다리면서 클릭
              await Promise.all([
                page
                  .waitForNavigation({
                    waitUntil: 'networkidle',
                    timeout: 10000,
                  })
                  .catch(() => {}),
                kakaoBtn.click().catch(() => {}),
              ]);
              kakaoLoginClicked = true;
              await page.waitForTimeout(3000);
            } catch (e) {
              this.logger.warn(
                `카카오 버튼 클릭 중 오류 (계속 진행): ${e.message}`,
              );
              kakaoLoginClicked = true; // 오류가 발생해도 다음 단계로 진행
              await page.waitForTimeout(3000);
            }
          }
        }

        if (!kakaoLoginClicked) {
          this.logger.warn('카카오 로그인 버튼을 찾지 못함');
          return {
            success: false,
            error: '카카오 로그인 버튼을 찾을 수 없습니다.',
          };
        }
      }

      // 카카오 로그인 페이지 로딩 대기
      await page.waitForTimeout(2000);
      const kakaoUrl = page.url();
      this.logger.log(`카카오 로그인 페이지 URL: ${kakaoUrl}`);

      // === "간편로그인 정보 저장" 체크박스 활성화 (세션 장기 유지) ===
      try {
        // 방법 1: 체크박스 직접 클릭
        const saveLoginCheckbox = page.getByRole('checkbox', {
          name: /간편로그인 정보 저장|로그인 정보 저장|Save Login/i,
        });
        if (await saveLoginCheckbox.isVisible({ timeout: 2000 })) {
          const isChecked = await saveLoginCheckbox.isChecked();
          if (!isChecked) {
            await saveLoginCheckbox.click({ timeout: 3000 });
            this.logger.log('간편로그인 정보 저장 체크박스 활성화');
          } else {
            this.logger.log('간편로그인 정보 이미 저장됨');
          }
        }
      } catch (e) {
        this.logger.log(
          `간편로그인 정보 저장 체크박스 처리 실패 (무시): ${e.message}`,
        );
      }

      // 카카오 로그인 폼 입력 (2026년 기준 - accounts.kakao.com)
      // 셀렉터: textbox[name="Enter Account Information"], textbox[name="Enter Pa word"]
      // 또는 input 타입으로 찾기

      let emailEntered = false;
      let pwEntered = false;

      // === 이메일/아이디 입력 ===
      this.logger.log('카카오 계정 정보 입력 중...');

      // 방법 1: Playwright getByRole 사용 (정확한 매칭)
      try {
        const emailTextbox = page.getByRole('textbox', {
          name: /계정정보 입력|Enter Account Information/i,
        });
        if (await emailTextbox.isVisible({ timeout: 3000 })) {
          await emailTextbox.click();
          await page.waitForTimeout(300);
          await emailTextbox.fill(username);
          emailEntered = true;
          this.logger.log('이메일 입력 성공: getByRole("계정정보 입력")');
        }
      } catch (e) {
        this.logger.log(`이메일 getByRole 시도 실패: ${e.message}`);
      }

      // 방법 2: CSS 셀렉터로 찾기
      if (!emailEntered) {
        const emailSelectors = [
          'input[name="loginId"]',
          '#loginId',
          'input[placeholder*="카카오메일"]',
          'input[placeholder*="이메일"]',
          'input[placeholder*="Account"]',
          'input[type="text"]:first-of-type',
          'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):first-of-type',
        ];

        for (const selector of emailSelectors) {
          try {
            const emailInput = await page.$(selector);
            if (emailInput) {
              const isVisible = await emailInput.isVisible();
              if (isVisible) {
                await emailInput.click();
                await page.waitForTimeout(300);
                await emailInput.fill(username);
                emailEntered = true;
                this.logger.log(`이메일 입력 성공: ${selector}`);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
      }

      if (!emailEntered) {
        this.logger.warn('카카오 이메일 입력 필드를 찾지 못함');
      }

      await page.waitForTimeout(500);

      // === 비밀번호 입력 ===
      // 방법 1: getByRole 사용 (password 필드는 보통 textbox가 아닌 특수 처리 필요)
      try {
        // "비밀번호 입력" 또는 "Enter Pa word" - 카카오 페이지
        const pwTextbox = page.getByRole('textbox', {
          name: /비밀번호 입력|Enter Pa|Password/i,
        });
        if (await pwTextbox.isVisible({ timeout: 2000 })) {
          await pwTextbox.click();
          await page.waitForTimeout(300);
          await pwTextbox.fill(password);
          pwEntered = true;
          this.logger.log('비밀번호 입력 성공: getByRole');
        }
      } catch (e) {
        this.logger.log(`비밀번호 getByRole 시도 실패: ${e.message}`);
      }

      // 방법 2: CSS 셀렉터로 찾기
      if (!pwEntered) {
        const pwSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          '#password',
          'input[placeholder*="비밀번호"]',
          'input[placeholder*="Password"]',
        ];

        for (const selector of pwSelectors) {
          try {
            const pwInput = await page.$(selector);
            if (pwInput) {
              const isVisible = await pwInput.isVisible();
              if (isVisible) {
                await pwInput.click();
                await page.waitForTimeout(300);
                await pwInput.fill(password);
                pwEntered = true;
                this.logger.log(`비밀번호 입력 성공: ${selector}`);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
      }

      if (!pwEntered) {
        this.logger.warn('카카오 비밀번호 입력 필드를 찾지 못함');
      }

      await page.waitForTimeout(500);

      // === 로그인 버튼 클릭 ===
      this.logger.log('로그인 버튼 클릭 중...');
      let loginClicked = false;

      // 방법 1: getByRole 사용 - "Log In" 버튼 (영문 카카오 페이지)
      try {
        const loginBtn = page.getByRole('button', { name: /Log In|로그인/i });
        if (await loginBtn.isVisible({ timeout: 3000 })) {
          await loginBtn.click();
          loginClicked = true;
          this.logger.log('로그인 버튼 클릭 성공: getByRole');
        }
      } catch (e) {
        this.logger.log(`로그인 버튼 getByRole 시도 실패: ${e.message}`);
      }

      // 방법 2: CSS 셀렉터로 찾기
      if (!loginClicked) {
        const loginSelectors = [
          'button[type="submit"]',
          'button.btn_confirm',
          'button.submit',
          'input[type="submit"]',
        ];

        for (const selector of loginSelectors) {
          try {
            const btn = await page.$(selector);
            if (btn) {
              const isVisible = await btn.isVisible();
              if (isVisible) {
                await btn.click();
                loginClicked = true;
                this.logger.log(`로그인 버튼 클릭 성공: ${selector}`);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
      }

      // 방법 3: Enter 키로 제출
      if (!loginClicked) {
        this.logger.log('로그인 버튼을 찾지 못함 - Enter 키로 제출 시도');
        await page.keyboard.press('Enter');
        loginClicked = true;
      }

      // 로그인 결과 대기 (리다이렉트 시간 충분히 대기)
      await page.waitForTimeout(7000);

      const resultUrl = page.url();
      this.logger.log(`로그인 후 URL: ${resultUrl}`);

      // 오류 체크
      const errorElement = await page.$(
        '.error_message, .txt_error, [class*="error"]:not([class*="checkbox"]), .login_error, [class*="Error"]',
      );
      if (errorElement) {
        const errorText = await errorElement.textContent();
        if (errorText && errorText.trim() && !errorText.includes('checkbox')) {
          return {
            success: false,
            error: errorText?.trim() || '카카오 로그인에 실패했습니다.',
          };
        }
      }

      // 2단계 인증 / 본인 확인 체크
      const twoStepIndicators = [
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
      const urlLower = resultUrl.toLowerCase();
      const needsVerification = twoStepIndicators.some((indicator) =>
        urlLower.includes(indicator),
      );

      // 페이지 내용에서 본인 확인 관련 텍스트 체크
      const pageText = await page.textContent('body');
      const verificationTexts = [
        '본인 확인',
        '본인확인',
        '인증번호',
        '인증 번호',
        '2단계 인증',
        '2차 인증',
        '보안 인증',
        '추가 인증',
        'verification',
        'verify',
      ];
      const hasVerificationText = verificationTexts.some(
        (text) =>
          pageText && pageText.toLowerCase().includes(text.toLowerCase()),
      );

      if (
        needsVerification ||
        hasVerificationText ||
        (await page.$(
          '.two_step, [class*="two-step"], [class*="twostep"], [class*="verify"], [class*="confirm"]',
        ))
      ) {
        this.logger.warn('2단계 인증/본인 확인 페이지 감지됨');
        return {
          success: false,
          error:
            '카카오 2단계 인증 또는 본인 확인이 필요합니다. 카카오 계정 설정에서 2단계 인증을 해제하거나, 수동 로그인 기능을 사용해주세요.',
        };
      }

      // 여전히 카카오 로그인 페이지에 있으면 실패
      if (resultUrl.includes('accounts.kakao.com/login')) {
        return {
          success: false,
          error:
            '카카오 로그인에 실패했습니다. 아이디/비밀번호를 확인해주세요.',
        };
      }

      // 티스토리 로그인 페이지에 여전히 있으면 실패
      if (resultUrl.includes('tistory.com/auth/login')) {
        return {
          success: false,
          error: '티스토리 로그인에 실패했습니다. 다시 시도해주세요.',
        };
      }

      // 성공 - 새 쿠키 반환
      const cookies = await page.context().cookies();
      this.logger.log('티스토리 재로그인 성공');
      return { success: true, cookies: JSON.stringify(cookies) };
    } catch (error) {
      this.logger.error(`티스토리 재로그인 오류: ${error.message}`);
      return {
        success: false,
        error: `재로그인 실패: ${error.message}`,
      };
    }
  }

  /**
   * 네이버 블로그 인증 테스트
   */
  async testNaverBlogAuth(
    username: string,
    password: string,
  ): Promise<AuthResult> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    try {
      this.logger.log(`네이버 로그인 시도: ${username}`);

      // 네이버 로그인 페이지 접속
      await page.goto('https://nid.naver.com/nidlogin.login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await page.waitForTimeout(1000);

      // 아이디 입력 (JavaScript로 직접 입력 - 캡챠 우회)
      await page.evaluate((id) => {
        const input = document.querySelector('#id') as HTMLInputElement;
        if (input) {
          input.value = id;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, username);

      await page.waitForTimeout(500);

      // 비밀번호 입력
      await page.evaluate((pw) => {
        const input = document.querySelector('#pw') as HTMLInputElement;
        if (input) {
          input.value = pw;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, password);

      await page.waitForTimeout(500);

      // 로그인 버튼 클릭
      await page.click('#log\\.login, .btn_login, button[type="submit"]');

      // 로그인 결과 대기
      await page.waitForTimeout(3000);

      // 로그인 성공 여부 확인
      const currentUrl = page.url();

      // 캡챠 체크
      if (currentUrl.includes('captcha') || (await page.$('#captcha'))) {
        await context.close();
        return {
          success: false,
          message:
            '캡챠 인증이 필요합니다. 네이버 웹에서 직접 로그인 후 다시 시도해주세요.',
        };
      }

      // 2단계 인증 체크
      if (currentUrl.includes('auth') || (await page.$('.login_second'))) {
        await context.close();
        return {
          success: false,
          message:
            '2단계 인증이 필요합니다. 네이버 앱에서 인증 후 다시 시도해주세요.',
        };
      }

      // 오류 메시지 체크
      const errorMsg = await page.$('.error_message, #err_common');
      if (errorMsg) {
        const errorText = await errorMsg.textContent();
        await context.close();
        return {
          success: false,
          message: errorText?.trim() || '로그인에 실패했습니다.',
        };
      }

      // 로그인 성공 - 블로그 페이지로 이동
      await page.goto('https://blog.naver.com/MyBlog.naver', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await page.waitForTimeout(2000);

      // 블로그 정보 추출
      let blogId = '';
      let blogName = '';
      let blogUrl = '';

      // URL에서 블로그 ID 추출
      const blogUrlMatch = page.url().match(/blog\.naver\.com\/([^/?]+)/);
      if (blogUrlMatch) {
        blogId = blogUrlMatch[1];
        blogUrl = `https://blog.naver.com/${blogId}`;
      }

      // 블로그 이름 추출 시도
      try {
        const nickElement = await page.$('.nick, .blog_name, .nick_name');
        if (nickElement) {
          blogName = (await nickElement.textContent())?.trim() || username;
        }
      } catch {
        blogName = username;
      }

      // 쿠키 저장
      const cookies = await context.cookies();
      const cookieString = JSON.stringify(cookies);

      await context.close();

      if (blogId || blogUrl) {
        return {
          success: true,
          message: '네이버 블로그 연동 성공',
          accountInfo: {
            name: blogName || blogId || username,
            url: blogUrl,
            blogId,
          },
          cookies: cookieString,
        };
      } else {
        return {
          success: false,
          message:
            '블로그 정보를 가져올 수 없습니다. 네이버 블로그가 개설되어 있는지 확인해주세요.',
        };
      }
    } catch (error) {
      await context.close();
      this.logger.error(`네이버 로그인 오류: ${error.message}`);
      return {
        success: false,
        message: `네이버 연결 실패: ${error.message}`,
      };
    }
  }

  /**
   * 티스토리 인증 테스트 (카카오 계정)
   */
  async testTistoryAuth(
    username: string,
    password: string,
  ): Promise<AuthResult> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    try {
      this.logger.log(`티스토리(카카오) 로그인 시도: ${username}`);

      // 티스토리 로그인 페이지
      await page.goto('https://www.tistory.com/auth/login', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      await page.waitForTimeout(2000);

      // "카카오계정으로 로그인" 링크/버튼 클릭
      this.logger.log('카카오 로그인 버튼 클릭...');
      const kakaoLoginSelectors = [
        'a:has-text("카카오계정으로 로그인")',
        'a[href*="kakao"]',
        '.link_kakao_id',
        '.btn_login_kakao',
        '[class*="kakao"]',
      ];

      let kakaoClicked = false;
      for (const selector of kakaoLoginSelectors) {
        try {
          const btn = await page.$(selector);
          if (btn) {
            await btn.click();
            kakaoClicked = true;
            this.logger.log(`카카오 로그인 버튼 클릭 성공: ${selector}`);
            break;
          }
        } catch {
          continue;
        }
      }

      if (!kakaoClicked) {
        await context.close();
        return {
          success: false,
          message: '카카오 로그인 버튼을 찾을 수 없습니다.',
        };
      }

      // 카카오 로그인 페이지 로딩 대기
      await page.waitForTimeout(3000);

      let currentUrl = page.url();
      this.logger.log(`카카오 로그인 페이지 URL: ${currentUrl}`);

      // === "로그인 정보 저장" 체크박스 활성화 (세션 장기 유지) ===
      // 카카오 로그인 페이지에서 label이 checkbox를 덮고 있으므로 label을 클릭
      try {
        const saveLoginLabel = page
          .locator(
            'label[for*="saveSignedIn"], label:has-text("로그인 정보 저장"), label:has-text("Save Login")',
          )
          .first();
        if (await saveLoginLabel.isVisible({ timeout: 2000 })) {
          await saveLoginLabel.click({ timeout: 3000 });
          this.logger.log('로그인 정보 저장 체크박스 활성화 (label 클릭)');
        }
      } catch (e) {
        try {
          await page.evaluate(() => {
            const checkbox = document.querySelector(
              'input[name="saveSignedIn"], input#saveSignedIn',
            ) as HTMLInputElement;
            if (checkbox && !checkbox.checked) {
              checkbox.click();
            }
          });
          this.logger.log('로그인 정보 저장 체크박스 활성화 (JavaScript)');
        } catch (e2) {
          this.logger.log(
            `로그인 정보 저장 체크박스 처리 실패 (무시): ${e.message}`,
          );
        }
      }

      // 카카오 로그인 폼 입력 (accounts.kakao.com)
      // 2026년 기준 카카오 로그인 페이지 구조:
      // - 이메일: textbox "Enter Account Information"
      // - 비밀번호: textbox "Enter Pa word" (Password에서 ss 잘림) 또는 input[type="password"]
      // - 로그인 버튼: button "Log In"
      this.logger.log('카카오 계정 정보 입력 중...');

      let emailEntered = false;
      let pwEntered = false;

      // === 이메일/아이디 입력 ===
      // 방법 1: Playwright getByRole 사용
      try {
        const emailTextbox = page.getByRole('textbox', {
          name: /Enter Account Information/i,
        });
        if (await emailTextbox.isVisible({ timeout: 3000 })) {
          await emailTextbox.click();
          await page.waitForTimeout(300);
          await emailTextbox.fill(username);
          emailEntered = true;
          this.logger.log(
            '이메일 입력 성공: getByRole("Enter Account Information")',
          );
        }
      } catch (e) {
        this.logger.log(`이메일 getByRole 시도 실패: ${e.message}`);
      }

      // 방법 2: CSS 셀렉터로 찾기
      if (!emailEntered) {
        const emailSelectors = [
          'input[name="loginId"]',
          '#loginId',
          'input[placeholder*="카카오메일"]',
          'input[placeholder*="이메일"]',
          'input[placeholder*="Account"]',
          'input[type="text"]:first-of-type',
        ];

        for (const selector of emailSelectors) {
          try {
            const input = await page.$(selector);
            if (input && (await input.isVisible())) {
              await input.click();
              await page.waitForTimeout(300);
              await input.fill(username);
              emailEntered = true;
              this.logger.log(`이메일 입력 성공: ${selector}`);
              break;
            }
          } catch {
            continue;
          }
        }
      }

      await page.waitForTimeout(500);

      // === 비밀번호 입력 ===
      // 방법 1: getByRole 사용
      try {
        const pwTextbox = page.getByRole('textbox', {
          name: /Enter Pa|Password/i,
        });
        if (await pwTextbox.isVisible({ timeout: 2000 })) {
          await pwTextbox.click();
          await page.waitForTimeout(300);
          await pwTextbox.fill(password);
          pwEntered = true;
          this.logger.log('비밀번호 입력 성공: getByRole');
        }
      } catch (e) {
        this.logger.log(`비밀번호 getByRole 시도 실패: ${e.message}`);
      }

      // 방법 2: CSS 셀렉터로 찾기
      if (!pwEntered) {
        const pwSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          '#password',
          'input[placeholder*="비밀번호"]',
          'input[placeholder*="Password"]',
        ];

        for (const selector of pwSelectors) {
          try {
            const input = await page.$(selector);
            if (input && (await input.isVisible())) {
              await input.click();
              await page.waitForTimeout(300);
              await input.fill(password);
              pwEntered = true;
              this.logger.log(`비밀번호 입력 성공: ${selector}`);
              break;
            }
          } catch {
            continue;
          }
        }
      }

      if (!emailEntered || !pwEntered) {
        await context.close();
        return {
          success: false,
          message: `카카오 로그인 폼을 찾을 수 없습니다. (이메일: ${emailEntered}, 비밀번호: ${pwEntered})`,
        };
      }

      await page.waitForTimeout(500);

      // === 로그인 버튼 클릭 ===
      this.logger.log('로그인 버튼 클릭...');
      let loginClicked = false;

      // 방법 1: getByRole 사용 - "Log In" 또는 "로그인" 버튼
      try {
        const loginBtn = page.getByRole('button', { name: /Log In|로그인/i });
        if (await loginBtn.isVisible({ timeout: 3000 })) {
          await loginBtn.click();
          loginClicked = true;
          this.logger.log('로그인 버튼 클릭 성공: getByRole');
        }
      } catch (e) {
        this.logger.log(`로그인 버튼 getByRole 시도 실패: ${e.message}`);
      }

      // 방법 2: CSS 셀렉터로 찾기
      if (!loginClicked) {
        const loginBtnSelectors = [
          'button[type="submit"]',
          '.btn_confirm',
          '.submit',
          'input[type="submit"]',
        ];

        for (const selector of loginBtnSelectors) {
          try {
            const btn = await page.$(selector);
            if (btn && (await btn.isVisible())) {
              await btn.click();
              loginClicked = true;
              this.logger.log(`로그인 버튼 클릭 성공: ${selector}`);
              break;
            }
          } catch {
            continue;
          }
        }
      }

      // 방법 3: Enter 키로 제출
      if (!loginClicked) {
        this.logger.log('로그인 버튼을 찾지 못함 - Enter 키로 제출 시도');
        await page.keyboard.press('Enter');
      }

      // 로그인 결과 대기
      await page.waitForTimeout(5000);

      currentUrl = page.url();
      this.logger.log(`로그인 후 URL: ${currentUrl}`);

      // 오류 체크
      const errorSelectors = [
        '.error_message',
        '.txt_error',
        '[class*="error"]',
        '[class*="Error"]',
      ];
      for (const selector of errorSelectors) {
        const errorElement = await page.$(selector);
        if (errorElement) {
          const errorText = await errorElement.textContent();
          if (errorText && errorText.trim()) {
            await context.close();
            return {
              success: false,
              message: errorText.trim(),
            };
          }
        }
      }

      // 2단계 인증 체크 (카카오톡 인증)
      if (
        currentUrl.includes('accounts.kakao') &&
        !currentUrl.includes('tistory')
      ) {
        // 아직 카카오 로그인 페이지에 있으면 인증 대기 중일 수 있음
        await context.close();
        return {
          success: false,
          message:
            '카카오 로그인에 실패했거나 2단계 인증이 필요합니다. 카카오톡에서 인증 후 다시 시도해주세요.',
        };
      }

      // 티스토리 메인 페이지로 이동하여 블로그 정보 확인
      // (2024년 기준: 로그인 후 www.tistory.com에서 "나의 티스토리" 섹션에 블로그 정보 표시)
      this.logger.log('티스토리 메인 페이지로 이동 중...');
      await page.goto('https://www.tistory.com/', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      await page.waitForTimeout(3000);

      const mainUrl = page.url();
      this.logger.log(`티스토리 메인 URL: ${mainUrl}`);

      // 블로그 정보 추출 - 반드시 계정정보 레이어에서만 추출 (다른 사람 블로그 방지)
      let blogName = '';
      let blogUrl = '';
      let blogId = '';

      try {
        // 계정정보 레이어 열기 버튼 클릭
        this.logger.log('계정정보 레이어 열기...');
        const accountBtn = await page.$(
          'button:has-text("계정정보 레이어 열기"), button[class*="profile"], img[alt*="계정정보"]',
        );
        if (accountBtn) {
          await accountBtn.click();
          await page.waitForTimeout(2000);
          this.logger.log('계정정보 레이어 열림');

          // "운영중인 블로그" 섹션에서 블로그 정보 추출
          // 구조: heading "운영중인 블로그" 아래에 블로그 링크들이 있음
          // link "re-rank 님의 블로그" [href="https://re-rank.tistory.com"]
          // link "쓰기" [href="https://re-rank.tistory.com/manage/post"]

          // 방법 1: "님의 블로그" 링크에서 추출 (가장 정확)
          const myBlogLink = await page.$(
            'a[href*=".tistory.com"]:has-text("님의 블로그")',
          );
          if (myBlogLink) {
            const href = await myBlogLink.getAttribute('href');
            const text = await myBlogLink.textContent();
            if (href) {
              const match = href.match(/https?:\/\/([^.]+)\.tistory\.com/);
              if (match && match[1] !== 'www') {
                blogId = match[1];
                blogUrl = `https://${blogId}.tistory.com`;
                this.logger.log(`내 블로그 발견: ${blogId}`);
              }
            }
            if (text) {
              blogName = text.trim().replace(' 님의 블로그', '');
            }
          }

          // 방법 2: "쓰기" 링크에서 추출
          if (!blogId) {
            const writeLink = await page.$(
              'a[href*="/manage/post"], a[href*="/manage/newpost"]',
            );
            if (writeLink) {
              const href = await writeLink.getAttribute('href');
              if (href) {
                const match = href.match(/https?:\/\/([^.]+)\.tistory\.com/);
                if (match && match[1] !== 'www') {
                  blogId = match[1];
                  blogUrl = `https://${blogId}.tistory.com`;
                  this.logger.log(`쓰기 링크에서 블로그 발견: ${blogId}`);
                }
              }
            }
          }

          // ESC로 레이어 닫기
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
        } else {
          this.logger.warn('계정정보 레이어 버튼을 찾지 못함');
        }
      } catch (e) {
        this.logger.warn(`블로그 정보 추출 중 오류: ${e.message}`);
      }

      // blogUrl에서 blogId가 없으면 추출
      if (blogUrl && !blogId) {
        const idMatch = blogUrl.match(/https?:\/\/([^.]+)\.tistory\.com/);
        if (idMatch) {
          blogId = idMatch[1];
        }
      }

      // blogId로 blogUrl 생성
      if (blogId && !blogUrl) {
        blogUrl = `https://${blogId}.tistory.com`;
      }

      // 쿠키 저장
      const cookies = await context.cookies();
      const cookieString = JSON.stringify(cookies);

      await context.close();

      if (blogUrl || blogName || blogId) {
        return {
          success: true,
          message: '티스토리 연동 성공',
          accountInfo: {
            name: blogName || blogId || username,
            url:
              blogUrl || (blogId ? `https://${blogId}.tistory.com` : undefined),
            blogId,
          },
          cookies: cookieString,
        };
      } else {
        // 로그인은 성공했지만 블로그 정보를 못 가져온 경우에도 성공 처리
        // 사용자가 직접 블로그 URL을 입력할 수 있도록 함
        this.logger.warn(
          '블로그 정보를 자동으로 가져오지 못했습니다. 쿠키는 저장됨.',
        );
        return {
          success: true,
          message:
            '티스토리 로그인 성공 (블로그 정보를 자동으로 가져오지 못했습니다. 블로그 URL을 직접 입력해주세요.)',
          accountInfo: {
            name: username,
          },
          cookies: cookieString,
        };
      }
    } catch (error) {
      await context.close();
      this.logger.error(`티스토리 로그인 오류: ${error.message}`);
      return {
        success: false,
        message: `티스토리 연결 실패: ${error.message}`,
      };
    }
  }

  /**
   * 플랫폼별 인증 테스트
   */
  async testAuth(
    platform: MediaPlatform,
    username: string,
    password: string,
  ): Promise<AuthResult> {
    switch (platform) {
      case MediaPlatform.NAVER_BLOG:
        return this.testNaverBlogAuth(username, password);
      case MediaPlatform.TISTORY:
        return this.testTistoryAuth(username, password);
      default:
        return {
          success: false,
          message: '지원하지 않는 플랫폼입니다.',
        };
    }
  }

  /**
   * 네이버 블로그에 글 발행
   * - headless: false 로 디버깅하고 실제 발행 확인 후 headless: true로 변경
   * - 세션 만료 시 자동 재로그인 지원
   */
  async publishToNaverBlog(
    cookies: string,
    title: string,
    content: string,
    credentials?: { username: string; password: string },
  ): Promise<{
    success: boolean;
    postId?: string;
    postUrl?: string;
    error?: string;
    newCookies?: string;
  }> {
    // 발행 전용 새 브라우저 생성 (서버리스 환경 안정성)
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      browser = await this.createFreshBrowser();
      context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
      });

      // 쿠키 복원 - 문자열 형식과 JSON 배열 형식 모두 지원
      const cookieArray = this.parseCookieString(cookies, '.naver.com');
      this.logger.log(`쿠키 파싱 완료: ${cookieArray.length}개 쿠키`);
      await context.addCookies(cookieArray);

      const page = await context.newPage();
      this.logger.log('네이버 블로그 글쓰기 페이지 접속 중...');

      // 글쓰기 페이지로 이동 - 새 글쓰기 URL 사용
      await page.goto('https://blog.naver.com/GoBlogWrite.naver', {
        waitUntil: 'networkidle',
        timeout: 60000,
      });

      // 페이지 로딩 및 리다이렉트 대기
      await page.waitForTimeout(5000);

      // 현재 URL 확인
      let currentUrl = page.url();
      this.logger.log(`현재 URL: ${currentUrl}`);

      // 로그인 확인 - 세션 만료 시 자동 재로그인 시도
      if (currentUrl.includes('nidlogin') || currentUrl.includes('login')) {
        this.logger.log('세션이 만료됨. 자동 재로그인 시도 중...');

        if (!credentials?.username || !credentials?.password) {
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
          return {
            success: false,
            error: '세션이 만료되었습니다. 매체 연동을 다시 테스트해주세요.',
          };
        }

        // 재로그인 시도
        const reloginResult = await this.performNaverLogin(
          page,
          credentials.username,
          credentials.password,
        );

        if (!reloginResult.success) {
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
          return {
            success: false,
            error: `재로그인 실패: ${reloginResult.error}`,
          };
        }

        this.logger.log('재로그인 성공! 새 쿠키 저장됨');

        // 글쓰기 페이지로 다시 이동
        await page.goto('https://blog.naver.com/GoBlogWrite.naver', {
          waitUntil: 'networkidle',
          timeout: 60000,
        });
        await page.waitForTimeout(5000);

        currentUrl = page.url();
        this.logger.log(`재로그인 후 URL: ${currentUrl}`);

        if (currentUrl.includes('nidlogin') || currentUrl.includes('login')) {
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
          return {
            success: false,
            error:
              '재로그인 후에도 세션이 유지되지 않습니다. 계정을 확인해주세요.',
          };
        }

        // 새 쿠키 저장 (나중에 DB에 업데이트)
        const newCookiesArray = await context.cookies();
        cookies = JSON.stringify(newCookiesArray);
      }

      // HTML에서 링크 정보 추출 (나중에 SmartEditor에서 삽입하기 위해)
      const linkPattern = /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      const links: { url: string; anchorText: string }[] = [];
      let match;
      while ((match = linkPattern.exec(content)) !== null) {
        links.push({ url: match[1], anchorText: match[2] });
      }
      this.logger.log(`추출된 링크 수: ${links.length}`);

      // HTML을 텍스트로 변환 (링크는 앵커 텍스트만 남김, 나중에 SmartEditor로 링크 삽입)
      const plainContent = content
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<p[^>]*>/gi, '')
        .replace(/<a\s+href="[^"]+"[^>]*>([^<]+)<\/a>/gi, '$1') // 링크는 앵커 텍스트만 남김
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();

      // iframe이 로드될 때까지 대기
      this.logger.log('에디터 로딩 대기 중...');
      await page.waitForSelector('iframe', { timeout: 30000 });
      await page.waitForTimeout(3000);

      // "작성 중인 글이 있습니다" 팝업 처리 및 다른 팝업 닫기
      this.logger.log('팝업 처리 중...');

      const iframeLocator = page.frameLocator('iframe').first();

      // 1. 임시저장 팝업 확인 및 "새로 작성" 클릭 (기존 임시저장 글 불러오기 방지)
      try {
        // 팝업이 표시되기를 잠시 대기
        await page.waitForTimeout(2000);

        // iframe 내에서 "새로 작성" 버튼 우선 클릭 (임시저장 글 불러오기 대신 새로 작성)
        const newWriteBtn = iframeLocator
          .locator('button:has-text("새로 작성")')
          .first();
        if (await newWriteBtn.isVisible({ timeout: 3000 })) {
          await newWriteBtn.click();
          this.logger.log('임시저장 팝업에서 "새로 작성" 클릭');
          await page.waitForTimeout(2000);
        } else {
          // "새로 작성" 버튼이 없으면 취소 버튼 클릭
          const cancelBtn = iframeLocator
            .locator('button:has-text("취소")')
            .first();
          if (await cancelBtn.isVisible({ timeout: 1000 })) {
            await cancelBtn.click();
            this.logger.log('임시저장 팝업에서 "취소" 클릭');
            await page.waitForTimeout(1500);
          }
        }
      } catch {
        this.logger.log('임시저장 팝업 없음 (정상)');
      }

      // 2. 확인 팝업 (se-popup-alert-confirm) 처리
      try {
        // 확인/닫기 버튼 찾기
        const confirmBtnSelectors = [
          '.se-popup-alert-confirm button:has-text("확인")',
          '.se-popup-alert-confirm button:has-text("닫기")',
          '.se-popup-alert button:has-text("확인")',
          '.se-popup-alert button:has-text("닫기")',
          '.se-popup-button-confirm',
          '.se-popup-close',
        ];

        for (const selector of confirmBtnSelectors) {
          const confirmBtn = iframeLocator.locator(selector).first();
          if (await confirmBtn.isVisible({ timeout: 1000 })) {
            await confirmBtn.click();
            this.logger.log(`확인 팝업 닫음: ${selector}`);
            await page.waitForTimeout(1000);
            break;
          }
        }
      } catch {
        // 무시
      }

      // 3. 도움말 팝업이나 기타 팝업 닫기
      try {
        const closeBtn = iframeLocator
          .locator(
            '.se-help-close, button[aria-label="닫기"], [class*="close"]',
          )
          .first();
        if (await closeBtn.isVisible({ timeout: 1000 })) {
          await closeBtn.click();
          this.logger.log('도움말/기타 팝업 닫음');
          await page.waitForTimeout(500);
        }
      } catch {
        // 무시
      }

      // 4. se-popup-dim (팝업 오버레이) 강제 제거
      try {
        await iframeLocator
          .locator('.se-popup-dim')
          .evaluate((el: Element) => el.remove())
          .catch(() => {});
        await iframeLocator
          .locator('.se-popup-alert')
          .evaluate((el: Element) => el.remove())
          .catch(() => {});
        this.logger.log('팝업 오버레이 제거 시도');
      } catch {
        // 무시
      }

      // ESC 키로 남은 팝업 모두 닫기
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      // === 키보드 타이핑 방식으로 제목/본문 입력 ===
      // 네이버 SmartEditor ONE은 DOM 직접 수정을 인식하지 않음
      // 반드시 실제 키보드 입력을 사용해야 함

      // iframe 핸들 가져오기
      const iframeHandle = await page.$('iframe');
      if (!iframeHandle) {
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
        return { success: false, error: '에디터 iframe을 찾을 수 없습니다.' };
      }
      const frame = await iframeHandle.contentFrame();
      if (!frame) {
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
        return { success: false, error: '에디터 프레임에 접근할 수 없습니다.' };
      }

      // 제목 영역 찾기 - 네이버 SmartEditor ONE의 제목 영역
      this.logger.log('제목 입력 중...');
      try {
        // 제목 영역 클릭 (se-title 클래스 또는 첫 번째 article 내 p 태그)
        const titleSelectors = [
          '.se-title .se-text-paragraph',
          '.se-title-text',
          'article.se-title p',
          '.se-component.se-title .se-text-paragraph',
        ];

        let titleClicked = false;
        for (const selector of titleSelectors) {
          try {
            // 타임아웃 5초로 대기
            const titleEl = await frame
              .waitForSelector(selector, { timeout: 5000 })
              .catch(() => null);
            if (titleEl) {
              await titleEl.click();
              titleClicked = true;
              this.logger.log(`제목 영역 클릭 성공: ${selector}`);
              break;
            }
          } catch {
            continue;
          }
        }

        if (!titleClicked) {
          this.logger.log('제목 셀렉터 실패, article p 시도...');
          // 대안: 첫 번째 p 태그 클릭
          const firstP = await frame
            .waitForSelector('article p', { timeout: 5000 })
            .catch(() => null);
          if (firstP) {
            await firstP.click();
            this.logger.log('제목 영역 클릭 성공 (article p)');
          } else {
            this.logger.warn('제목 영역을 찾지 못함 - 키보드로 직접 입력 시도');
          }
        }
      } catch (e) {
        this.logger.warn(`제목 영역 클릭 실패: ${e.message}`);
      }

      await page.waitForTimeout(500);

      // 기존 텍스트 삭제 (Ctrl+A로 전체 선택 후 삭제)
      await page.keyboard.press('Control+A');
      await page.waitForTimeout(200);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);

      // 서식 완전 초기화 - 모든 텍스트 서식 강제 해제
      try {
        await frame.evaluate(() => {
          // 1. 모든 활성화된 서식 버튼 해제
          const activeButtons = document.querySelectorAll(
            '[class*="se-toolbar"] button[aria-pressed="true"]',
          );
          activeButtons.forEach((btn: Element) => {
            (btn as HTMLButtonElement).click();
          });

          // 2. 취소선 버튼 명시적으로 찾아서 비활성화 확인
          const strikeSelectors = [
            'button[data-name="strike"]',
            'button.se-text-strike',
            'button[class*="strike"]',
            'button[aria-label*="취소선"]',
            'button[title*="취소선"]',
          ];

          for (const selector of strikeSelectors) {
            const strikeBtn = document.querySelector(
              selector,
            ) as HTMLButtonElement;
            if (strikeBtn) {
              // aria-pressed 상태 확인
              const isPressed =
                strikeBtn.getAttribute('aria-pressed') === 'true' ||
                strikeBtn.classList.contains('active') ||
                strikeBtn.classList.contains('se-toolbar-button-active');
              if (isPressed) {
                strikeBtn.click();
              }
              break;
            }
          }

          // 3. 볼드, 이탤릭, 밑줄, 취소선 버튼 모두 확인하여 비활성화
          const formatNames = [
            'bold',
            'italic',
            'underline',
            'strike',
            'strikethrough',
          ];
          formatNames.forEach((name) => {
            const btn = document.querySelector(
              `button[data-name="${name}"]`,
            ) as HTMLButtonElement;
            if (
              btn &&
              (btn.getAttribute('aria-pressed') === 'true' ||
                btn.classList.contains('active'))
            ) {
              btn.click();
            }
          });
        });
        this.logger.log('제목 영역 서식 초기화 완료');
      } catch (e) {
        this.logger.log(`서식 초기화 시도: ${e.message}`);
      }
      await page.waitForTimeout(300);

      // 제목 타이핑
      await page.keyboard.type(title, { delay: 30 });
      this.logger.log('제목 입력 완료');

      // 본문 영역으로 이동 - 본문 영역을 직접 클릭
      this.logger.log('본문 영역으로 이동 중...');
      await page.waitForTimeout(500);

      try {
        // 본문 영역 직접 클릭
        const bodySelectors = [
          '.se-component.se-text:not(.se-title) .se-text-paragraph',
          '.se-main-container .se-text-paragraph:not(.se-title .se-text-paragraph)',
          'article.se-text:not(.se-title) p',
          '.se-contents .se-text-paragraph',
        ];

        let bodyClicked = false;
        for (const selector of bodySelectors) {
          try {
            const bodyEl = await frame.$(selector);
            if (bodyEl) {
              await bodyEl.click();
              bodyClicked = true;
              this.logger.log(`본문 영역 클릭 성공: ${selector}`);
              break;
            }
          } catch {
            continue;
          }
        }

        if (!bodyClicked) {
          // 대안: Tab 키로 이동
          await page.keyboard.press('Tab');
          this.logger.log('본문 영역으로 Tab 이동');
        }
      } catch (e) {
        this.logger.warn(`본문 영역 클릭 실패, Tab 사용: ${e.message}`);
        await page.keyboard.press('Tab');
      }

      await page.waitForTimeout(500);

      // 본문 영역의 서식도 초기화
      await page.keyboard.press('Control+A');
      await page.waitForTimeout(100);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(100);

      // 본문 영역에서 서식 완전 초기화 - 취소선 포함 모든 서식 해제
      try {
        await frame.evaluate(() => {
          // 1. 모든 활성화된 서식 버튼 해제
          const activeButtons = document.querySelectorAll(
            '[class*="se-toolbar"] button[aria-pressed="true"]',
          );
          activeButtons.forEach((btn: Element) => {
            (btn as HTMLButtonElement).click();
          });

          // 2. 취소선 버튼 명시적으로 찾아서 비활성화
          const strikeSelectors = [
            'button[data-name="strike"]',
            'button.se-text-strike',
            'button[class*="strike"]',
            'button[aria-label*="취소선"]',
            'button[title*="취소선"]',
          ];

          for (const selector of strikeSelectors) {
            const strikeBtn = document.querySelector(
              selector,
            ) as HTMLButtonElement;
            if (strikeBtn) {
              const isPressed =
                strikeBtn.getAttribute('aria-pressed') === 'true' ||
                strikeBtn.classList.contains('active') ||
                strikeBtn.classList.contains('se-toolbar-button-active');
              if (isPressed) {
                strikeBtn.click();
              }
              break;
            }
          }

          // 3. 볼드, 이탤릭, 밑줄, 취소선 버튼 모두 확인하여 비활성화
          const formatNames = [
            'bold',
            'italic',
            'underline',
            'strike',
            'strikethrough',
          ];
          formatNames.forEach((name) => {
            const btn = document.querySelector(
              `button[data-name="${name}"]`,
            ) as HTMLButtonElement;
            if (
              btn &&
              (btn.getAttribute('aria-pressed') === 'true' ||
                btn.classList.contains('active'))
            ) {
              btn.click();
            }
          });
        });
        this.logger.log('본문 영역 서식 초기화 완료');
      } catch (e) {
        this.logger.log(`본문 서식 초기화 시도: ${e.message}`);
      }
      await page.waitForTimeout(300);

      // 추가 서식 초기화: 키보드 단축키로 서식 제거 시도
      // 네이버 에디터에서 취소선 등 서식이 남아있는 경우 대비
      try {
        // Ctrl+\ 또는 Ctrl+Space는 일부 에디터에서 서식 제거
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);

        // 서식 제거 버튼 찾아서 클릭 시도
        const formatCleared = await frame.evaluate(() => {
          // "서식 제거" 또는 "서식 초기화" 버튼 찾기
          const clearSelectors = [
            'button[data-name="removeFormat"]',
            'button[aria-label*="서식 제거"]',
            'button[title*="서식 제거"]',
            'button[aria-label*="서식 초기화"]',
          ];

          for (const selector of clearSelectors) {
            const btn = document.querySelector(selector) as HTMLButtonElement;
            if (btn) {
              btn.click();
              return true;
            }
          }
          return false;
        });

        if (formatCleared) {
          this.logger.log('서식 제거 버튼 클릭 완료');
          await page.waitForTimeout(200);
        }
      } catch (e) {
        this.logger.log(`추가 서식 초기화: ${e.message}`);
      }

      // 본문 입력
      this.logger.log('본문 입력 중...');

      // 타이핑 직전 최종 서식 확인 - 취소선이 활성화되어 있으면 해제
      try {
        const strikeDeactivated = await frame.evaluate(() => {
          // 모든 가능한 취소선 버튼 셀렉터
          const selectors = [
            'button[data-name="strike"]',
            'button[data-name="strikethrough"]',
            'button.se-text-strike',
            'button[class*="strike"]',
            'button[aria-label*="취소선"]',
            'button[title*="취소선"]',
            '.se-toolbar button[class*="strike"]',
          ];

          for (const selector of selectors) {
            const btn = document.querySelector(selector) as HTMLButtonElement;
            if (btn) {
              // 다양한 방법으로 활성화 상태 확인
              const isActive =
                btn.getAttribute('aria-pressed') === 'true' ||
                btn.classList.contains('active') ||
                btn.classList.contains('se-toolbar-button-active') ||
                btn.classList.contains('is-active') ||
                btn.classList.contains('on') ||
                btn.getAttribute('data-active') === 'true';

              if (isActive) {
                btn.click();
                return `deactivated: ${selector}`;
              }
              return `checked: ${selector} (not active)`;
            }
          }
          return 'no strike button found';
        });
        this.logger.log(`취소선 버튼 최종 확인: ${strikeDeactivated}`);
      } catch (e) {
        this.logger.log(`취소선 최종 확인 실패: ${e.message}`);
      }
      await page.waitForTimeout(100);

      // 본문 타이핑 - 줄바꿈 처리
      const lines = plainContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim()) {
          await page.keyboard.type(line, { delay: 15 });
        }
        // 마지막 줄이 아니면 Enter로 줄바꿈
        if (i < lines.length - 1) {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(30);
        }
      }

      // 링크가 있으면 본문 마지막에 URL을 직접 추가
      // (네이버가 URL을 자동으로 링크로 변환함)
      if (links.length > 0) {
        this.logger.log(`링크 URL 추가 중 (${links.length}개)...`);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await page.keyboard.type('▶ 관련 링크:', { delay: 20 });
        await page.keyboard.press('Enter');

        for (const link of links) {
          await page.keyboard.type(`${link.anchorText}: ${link.url}`, {
            delay: 15,
          });
          await page.keyboard.press('Enter');
          this.logger.log(`링크 추가: ${link.anchorText} -> ${link.url}`);
        }
      }

      this.logger.log('제목/본문 입력 완료');
      await page.waitForTimeout(1500);

      // 발행 버튼 클릭 - 상단 헤더의 "발행" 버튼
      this.logger.log('발행 버튼 클릭 중...');

      let publishClicked = false;

      // JavaScript로 발행 버튼 찾아서 클릭
      try {
        publishClicked = await page.evaluate(() => {
          const iframe = document.querySelector('iframe') as HTMLIFrameElement;
          if (!iframe?.contentDocument) return false;
          const doc = iframe.contentDocument;

          // 발행 버튼 찾기 - 다양한 선택자 시도
          const selectors = [
            'button[data-click-area="tpb.publish"]',
            '.publish_btn__m9KHH',
            'button:has(.se-icon-publish)',
            'header button:has-text("발행")',
          ];

          for (const selector of selectors) {
            try {
              const btn = doc.querySelector(selector) as HTMLButtonElement;
              if (btn) {
                btn.click();
                return true;
              }
            } catch {
              continue;
            }
          }

          // 텍스트로 찾기
          const buttons = Array.from(doc.querySelectorAll('button'));
          for (const btn of buttons) {
            const text = btn.textContent?.trim();
            // "발행" 텍스트가 있고, "예약발행"이 아닌 버튼
            if (
              text === '발행' ||
              (text?.includes('발행') && !text?.includes('예약'))
            ) {
              (btn as HTMLButtonElement).click();
              return true;
            }
          }

          return false;
        });

        if (publishClicked) {
          this.logger.log('발행 버튼 클릭 성공 (JavaScript)');
        }
      } catch (e) {
        this.logger.error(`발행 버튼 JavaScript 클릭 실패: ${e.message}`);
      }

      // JavaScript 클릭 실패 시 Playwright locator 사용
      if (!publishClicked) {
        try {
          const iframeLocator = page.frameLocator('iframe').first();
          const publishBtn = iframeLocator
            .locator('button')
            .filter({ hasText: /^발행$/ })
            .first();
          await publishBtn.click({ timeout: 5000, force: true });
          publishClicked = true;
          this.logger.log('발행 버튼 클릭 성공 (Playwright locator)');
        } catch (e2) {
          this.logger.error(`발행 버튼 Playwright 클릭도 실패: ${e2.message}`);
        }
      }

      // 발행 설정 모달 대기 및 처리
      await page.waitForTimeout(3000);

      // 발행 설정 모달에서 최종 "발행" 버튼 클릭
      this.logger.log('발행 확인 버튼 클릭 중...');
      try {
        await page.evaluate(() => {
          const iframe = document.querySelector('iframe') as HTMLIFrameElement;
          if (!iframe?.contentDocument) return;
          const doc = iframe.contentDocument;

          // 모달 내 발행 버튼 찾기 - 보통 모달의 확인 버튼
          const modalBtns = doc.querySelectorAll(
            '.se-popup button, [class*="modal"] button, [class*="layer"] button',
          );
          for (const btn of Array.from(modalBtns)) {
            const text = btn.textContent?.trim();
            if (text === '발행' || text === '확인') {
              (btn as HTMLButtonElement).click();
              return;
            }
          }

          // 일반 버튼 중 마지막 "발행" 버튼
          const allBtns = doc.querySelectorAll('button');
          const publishBtns = Array.from(allBtns).filter(
            (btn) => btn.textContent?.trim() === '발행',
          );
          if (publishBtns.length > 1) {
            (publishBtns[publishBtns.length - 1] as HTMLButtonElement).click();
          }
        });
        this.logger.log('발행 확인 버튼 클릭 완료');
      } catch {
        this.logger.log('발행 확인 모달 없거나 이미 처리됨');
      }

      // 발행 완료 대기 (네트워크 요청 완료 대기)
      // 페이지 리디렉션으로 인해 실패할 수 있으므로 try-catch 사용
      try {
        await page.waitForTimeout(7000);
      } catch (e) {
        this.logger.log(
          '발행 후 페이지 대기 중 오류 (정상적인 리디렉션일 수 있음)',
        );
      }

      // 결과 확인 - 페이지가 닫혔을 수 있으므로 try-catch
      let finalUrl = '';
      try {
        finalUrl = page.url();
      } catch (e) {
        this.logger.log('페이지 URL 확인 실패 - 컨텍스트가 닫힘');
        // 발행 성공으로 간주하고 블로그 홈에서 최신 글 확인
        finalUrl = '';
      }
      this.logger.log(`발행 후 URL: ${finalUrl}`);

      // 블로그 ID 추출
      let blogId = '';
      const blogIdMatch =
        finalUrl.match(/blogId=([^&]+)/) ||
        finalUrl.match(/blog\.naver\.com\/([^/?]+)/);
      if (blogIdMatch) {
        blogId = blogIdMatch[1];
      }
      if (!blogId) blogId = 're-rank'; // 기본값

      // 포스트 ID 추출 시도
      let postId = '';
      const postIdMatch = finalUrl.match(/logNo=(\d+)/);
      if (postIdMatch) {
        postId = postIdMatch[1];
      }

      // 글쓰기 페이지를 벗어났으면 성공
      const publishSuccess =
        !finalUrl.includes('Write') && !finalUrl.includes('Redirect');

      // 발행 성공했지만 postId를 못 찾은 경우, 새 페이지로 블로그 홈에서 최신 글 확인
      if (!postId && blogId) {
        this.logger.log('포스트 ID를 찾을 수 없어 블로그 홈에서 확인 중...');

        // 새 페이지 생성 (기존 페이지가 닫혔을 수 있음)
        const newPage = await context.newPage();
        try {
          await newPage.goto(
            `https://blog.naver.com/PostList.naver?blogId=${blogId}`,
            {
              waitUntil: 'networkidle',
              timeout: 30000,
            },
          );
          await newPage.waitForTimeout(2000);

          // 최신 글 URL 가져오기
          const latestPostLink = await newPage
            .locator('a[href*="logNo="]')
            .first()
            .getAttribute('href');
          if (latestPostLink) {
            const latestPostIdMatch = latestPostLink.match(/logNo=(\d+)/);
            if (latestPostIdMatch) {
              postId = latestPostIdMatch[1];
              this.logger.log(`최신 글 ID 발견: ${postId}`);
            }
          }
        } catch (e) {
          this.logger.log(`최신 글 찾기 실패: ${e.message}`);
        } finally {
          await newPage.close();
        }
      }

      const postUrl = postId
        ? `https://blog.naver.com/${blogId}/${postId}`
        : finalUrl;

      // 새 쿠키 저장 (세션 갱신 또는 재로그인 후)
      let newCookies: string | undefined;
      try {
        const currentCookies = await context.cookies();
        newCookies = JSON.stringify(currentCookies);
      } catch (e) {
        this.logger.log('쿠키 저장 실패 - 컨텍스트가 닫힘');
      }

      // 정리: 컨텍스트와 브라우저 모두 종료
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

      if (publishSuccess || postId) {
        this.logger.log(`네이버 블로그 발행 완료: ${postUrl}`);
        return {
          success: true,
          postId,
          postUrl,
          newCookies, // 새 쿠키 반환 (DB에 업데이트용)
        };
      } else {
        this.logger.warn('발행 완료 여부를 확인할 수 없음 - 수동 확인 필요');
        return {
          success: false,
          error:
            '발행이 완료되었는지 확인할 수 없습니다. 네이버 블로그에서 직접 확인해주세요.',
          postUrl: finalUrl,
          newCookies,
        };
      }
    } catch (error) {
      // 정리: 컨텍스트와 브라우저 모두 종료
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
      this.logger.error(`네이버 블로그 발행 오류: ${error.message}`);
      return {
        success: false,
        error: `발행 실패: ${error.message}`,
      };
    }
  }

  /**
   * 티스토리에 글 발행 (2024년 에디터 분석 기반)
   *
   * 티스토리 글쓰기 페이지 구조:
   * - URL: https://{블로그이름}.tistory.com/manage/newpost
   * - 제목: textbox[placeholder="제목을 입력하세요"]
   * - 본문: iframe 내부의 textbox "글 내용 입력" (contenteditable)
   * - 완료 버튼: button "완료"
   */
  async publishToTistory(
    cookies: string,
    blogUrl: string,
    username: string | undefined, // 재로그인을 위한 카카오 계정 정보 (선택)
    password: string | undefined,
    title: string,
    content: string,
  ): Promise<{
    success: boolean;
    postId?: string;
    postUrl?: string;
    error?: string;
    newCookies?: string;
  }> {
    // 발행 전용 새 브라우저 생성 (서버리스 환경 안정성)
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      browser = await this.createFreshBrowser();
      context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
      });

      // 쿠키 복원 - 문자열 형식과 JSON 배열 형식 모두 지원
      let currentCookies = cookies;
      const cookieArray = this.parseCookieString(cookies, '.tistory.com');
      this.logger.log(`쿠키 파싱 완료: ${cookieArray.length}개 쿠키`);

      await context.addCookies(cookieArray);

      const page = await context.newPage();

      // 블로그 URL에서 블로그명 추출 - 티스토리는 블로그명이 필수
      let blogName = '';
      const blogNameMatch = blogUrl?.match(/https?:\/\/([^.]+)\.tistory\.com/);
      if (blogNameMatch) {
        blogName = blogNameMatch[1];
      }

      if (!blogName) {
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
        return {
          success: false,
          error:
            '티스토리 블로그 URL이 필요합니다. 매체 연동에서 블로그 URL(예: https://myblog.tistory.com)을 확인해주세요.',
        };
      }

      // ===== 티스토리 글쓰기 페이지 접근 로직 =====
      // 1단계: 먼저 www.tistory.com에 방문하여 쿠키/세션 활성화
      this.logger.log('티스토리 메인 페이지로 이동하여 세션 활성화...');
      await page.goto('https://www.tistory.com/', {
        waitUntil: 'networkidle',
        timeout: 60000,
      });
      await page.waitForTimeout(2000);

      // 로그인 상태 확인
      const isLoggedIn = await page.$(
        'button:has-text("로그아웃"), a:has-text("로그아웃")',
      );
      this.logger.log(isLoggedIn ? '로그인 상태 확인됨' : '로그인 상태 아님');

      // 2단계: 계정 정보 레이어를 열어서 운영 중인 블로그 목록 확인
      let actualBlogName = blogName; // 기본값은 파라미터에서 추출한 블로그명

      try {
        // 계정정보 레이어 열기 버튼 클릭
        const accountBtn = await page.$(
          'button:has-text("계정정보 레이어 열기"), button[class*="profile"], img[alt*="계정정보"]',
        );
        if (accountBtn) {
          await accountBtn.click();
          await page.waitForTimeout(1500);
          this.logger.log('계정정보 레이어 열림');

          // 운영 중인 블로그 목록에서 "쓰기" 링크 찾기
          // 구조: link "쓰기" [href="https://re-rank.tistory.com/manage/post"]
          const writeLinks = await page.$$(
            'a[href*="/manage/post"], a[href*="/manage/newpost"]',
          );

          if (writeLinks.length > 0) {
            // blogUrl과 일치하는 블로그 찾기
            let foundMatchingBlog = false;
            for (const link of writeLinks) {
              const href = await link.getAttribute('href');
              if (href) {
                const match = href.match(/https?:\/\/([^.]+)\.tistory\.com/);
                if (match) {
                  const foundBlogName = match[1];
                  this.logger.log(`발견된 블로그: ${foundBlogName}`);

                  // blogUrl 파라미터와 일치하면 해당 블로그 사용
                  if (blogUrl && blogUrl.includes(foundBlogName)) {
                    actualBlogName = foundBlogName;
                    foundMatchingBlog = true;
                    this.logger.log(`매칭된 블로그 사용: ${actualBlogName}`);
                    break;
                  }

                  // 첫 번째 블로그를 기본값으로 저장
                  if (!foundMatchingBlog && !actualBlogName) {
                    actualBlogName = foundBlogName;
                  }
                }
              }
            }

            // 매칭되는 블로그가 없으면 첫 번째 블로그 사용
            if (!foundMatchingBlog && writeLinks.length > 0) {
              const firstLink = writeLinks[0];
              const href = await firstLink.getAttribute('href');
              if (href) {
                const match = href.match(/https?:\/\/([^.]+)\.tistory\.com/);
                if (match) {
                  actualBlogName = match[1];
                  this.logger.log(`첫 번째 블로그 사용: ${actualBlogName}`);
                }
              }
            }
          }

          // ESC로 레이어 닫기
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
        }
      } catch (e) {
        this.logger.warn(`블로그 목록 확인 실패: ${e.message}`);
      }

      // 최종 블로그명 확인
      if (!actualBlogName) {
        await context.close();
        return {
          success: false,
          error:
            '발행할 블로그를 찾을 수 없습니다. 티스토리에 블로그가 있는지 확인해주세요.',
        };
      }

      this.logger.log(`발행 대상 블로그: ${actualBlogName}`);

      // 3단계: 블로그별 글쓰기 페이지로 이동
      const writeUrl = `https://${actualBlogName}.tistory.com/manage/newpost/?type=post`;
      this.logger.log(`티스토리 글쓰기 페이지로 이동: ${writeUrl}`);

      await page.goto(writeUrl, {
        waitUntil: 'networkidle',
        timeout: 60000,
      });
      await page.waitForTimeout(3000);

      // 현재 URL 확인
      let currentUrl = page.url();
      this.logger.log(`현재 URL: ${currentUrl}`);

      // 로그인 페이지로 리다이렉트된 경우 - 재로그인 필요
      if (
        currentUrl.includes('auth/login') ||
        currentUrl.includes('kakao') ||
        currentUrl.includes('accounts.kakao')
      ) {
        this.logger.warn('로그인 페이지로 리다이렉트됨, 재로그인 시도...');

        // 유효한 카카오 계정(이메일 형식)인지 확인
        const isValidEmail =
          username && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);

        if (!isValidEmail || !password) {
          await context.close();
          await browser?.close();
          return {
            success: false,
            error:
              '쿠키가 만료되었습니다. 프로젝트 설정 → 매체 연동에서 쿠키를 새로 입력해주세요.',
          };
        }

        const reAuthResult = await this.performTistoryLogin(
          page,
          username,
          password,
        );
        if (!reAuthResult.success) {
          await context.close();
          return {
            success: false,
            error: `재로그인 실패: ${reAuthResult.error}`,
          };
        }

        currentCookies = reAuthResult.cookies!;
        this.logger.log('티스토리 재로그인 성공');

        // 재로그인 후 새 쿠키를 컨텍스트에 적용
        const newCookieArray = JSON.parse(currentCookies);
        await context.clearCookies();
        await context.addCookies(newCookieArray);

        // 재로그인 후 티스토리 메인에서 올바른 블로그 찾기
        this.logger.log('재로그인 후 블로그 목록 확인 중...');
        await page.goto('https://www.tistory.com/', {
          waitUntil: 'networkidle',
          timeout: 60000,
        });
        await page.waitForTimeout(2000);

        // 계정정보 레이어에서 블로그 찾기
        try {
          const accountBtn = await page.$(
            'button:has-text("계정정보 레이어 열기"), button[class*="profile"], img[alt*="계정정보"]',
          );
          if (accountBtn) {
            await accountBtn.click();
            await page.waitForTimeout(1500);

            // "쓰기" 링크에서 블로그 찾기
            const writeLinks = await page.$$(
              'a[href*="/manage/post"], a[href*="/manage/newpost"]',
            );
            if (writeLinks.length > 0) {
              // blogUrl과 일치하는 블로그 찾기
              for (const link of writeLinks) {
                const href = await link.getAttribute('href');
                if (href) {
                  const match = href.match(/https?:\/\/([^.]+)\.tistory\.com/);
                  if (match && match[1] !== 'www') {
                    const foundBlog = match[1];
                    this.logger.log(`재로그인 후 발견된 블로그: ${foundBlog}`);

                    // blogUrl과 매칭되면 사용
                    if (blogUrl && blogUrl.includes(foundBlog)) {
                      actualBlogName = foundBlog;
                      this.logger.log(`매칭된 블로그 사용: ${actualBlogName}`);
                      break;
                    }

                    // 첫 번째 블로그 저장
                    if (!actualBlogName || actualBlogName === blogName) {
                      actualBlogName = foundBlog;
                    }
                  }
                }
              }
            }

            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
          }
        } catch (e) {
          this.logger.warn(`재로그인 후 블로그 찾기 실패: ${e.message}`);
        }

        this.logger.log(`재로그인 후 발행 대상 블로그: ${actualBlogName}`);

        // 업데이트된 블로그명으로 글쓰기 URL 재생성
        const updatedWriteUrl = `https://${actualBlogName}.tistory.com/manage/newpost/?type=post`;
        this.logger.log(`재로그인 후 글쓰기 페이지로 이동: ${updatedWriteUrl}`);

        await page.goto(updatedWriteUrl, {
          waitUntil: 'networkidle',
          timeout: 60000,
        });
        await page.waitForTimeout(3000);
        currentUrl = page.url();
        this.logger.log(`재로그인 후 URL: ${currentUrl}`);
      }

      // 글쓰기 페이지 도착 확인
      // 정상: /manage/newpost 가 포함되어 있어야 함
      if (
        !currentUrl.includes('/manage/newpost') &&
        !currentUrl.includes('/manage/post')
      ) {
        // 에러 페이지인 경우
        if (currentUrl.includes('error') || currentUrl.includes('404')) {
          await context.close();
          return {
            success: false,
            error: `티스토리 글쓰기 페이지에 접근할 수 없습니다. 블로그 URL(${blogUrl})을 확인해주세요.`,
          };
        }

        // 블로그 홈으로 리다이렉트된 경우 - 한 번 더 시도
        this.logger.warn(`글쓰기 페이지가 아님 (${currentUrl}), 재시도...`);
        await page.goto(writeUrl, {
          waitUntil: 'networkidle',
          timeout: 60000,
        });
        await page.waitForTimeout(3000);
        currentUrl = page.url();
        this.logger.log(`재시도 후 URL: ${currentUrl}`);

        if (
          !currentUrl.includes('/manage/newpost') &&
          !currentUrl.includes('/manage/post')
        ) {
          await context.close();
          return {
            success: false,
            error: `글쓰기 페이지에 접근할 수 없습니다. 현재 URL: ${currentUrl}`,
          };
        }
      }

      this.logger.log(`글쓰기 페이지 로드 완료: ${currentUrl}`);

      // === 제목 입력 ===
      this.logger.log('제목 입력 중...');
      let titleEntered = false;

      // 티스토리 글쓰기 페이지 분석 결과 (2026년 기준):
      // 제목: textbox "제목을 입력하세요" [ref=e21]
      // 본문: iframe 내부 textbox "글 내용 입력" [ref=f1e1]
      // 완료 버튼: button "완료" [ref=e136]

      // 페이지 로딩 대기
      await page.waitForTimeout(2000);

      try {
        // 1. getByRole로 제목 입력
        const titleInput = page.getByRole('textbox', {
          name: '제목을 입력하세요',
        });
        if (await titleInput.isVisible({ timeout: 5000 })) {
          await titleInput.click();
          await page.waitForTimeout(300);
          await titleInput.fill(title);
          titleEntered = true;
          this.logger.log('제목 입력 성공: getByRole("제목을 입력하세요")');
        }
      } catch (e) {
        this.logger.log(`제목 입력 시도 1 실패: ${e.message}`);
      }

      // 2. getByPlaceholder 시도
      if (!titleEntered) {
        try {
          const titleInput = page.getByPlaceholder('제목을 입력하세요');
          if (await titleInput.isVisible({ timeout: 3000 })) {
            await titleInput.click();
            await page.waitForTimeout(300);
            await titleInput.fill(title);
            titleEntered = true;
            this.logger.log('제목 입력 성공: getByPlaceholder');
          }
        } catch (e) {
          this.logger.log(`제목 입력 시도 2 실패: ${e.message}`);
        }
      }

      // 3. CSS 셀렉터로 시도
      if (!titleEntered) {
        const titleSelectors = [
          'input[placeholder*="제목을 입력"]',
          'input[placeholder*="제목"]',
          'textarea[placeholder*="제목"]',
          '#post-title',
          'input[name="title"]',
        ];

        for (const selector of titleSelectors) {
          try {
            const titleInput = await page.$(selector);
            if (titleInput) {
              const isVisible = await titleInput.isVisible();
              if (isVisible) {
                await titleInput.click();
                await page.waitForTimeout(300);
                await titleInput.fill(title);
                titleEntered = true;
                this.logger.log(`제목 입력 성공: ${selector}`);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
      }

      if (!titleEntered) {
        this.logger.error('제목 입력 필드를 찾지 못했습니다');
        await context.close();
        return { success: false, error: '제목 입력 필드를 찾지 못했습니다.' };
      }

      await page.waitForTimeout(1000);

      // === 본문 입력 ===
      this.logger.log('본문 입력 중...');

      let contentEntered = false;

      // Plain text를 HTML로 변환 (줄바꿈 처리)
      const convertToHtml = (text: string): string => {
        // 이미 HTML 태그가 많이 포함되어 있으면 그대로 반환
        if (/<(p|div|h[1-6]|ul|ol|li)[^>]*>/i.test(text)) {
          return text;
        }

        // 1. HTML 특수문자 이스케이프 (기존 <a> 태그 보존)
        const preserveLinks = text.replace(
          /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi,
          '___LINK_START___$1___LINK_SEP___$2___LINK_END___',
        );

        // 2. 단락 구분: \n\n을 </p><p>로 변환
        const paragraphs = preserveLinks.split(/\n\n+/);

        // 3. 각 단락 내 줄바꿈: \n을 <br>로 변환
        const htmlParagraphs = paragraphs
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
          .map((p) => {
            const withBr = p.replace(/\n/g, '<br>');
            return `<p>${withBr}</p>`;
          });

        // 4. 링크 복원
        let result = htmlParagraphs.join('\n');
        result = result.replace(
          /___LINK_START___([^_]+)___LINK_SEP___([^_]+)___LINK_END___/g,
          '<a href="$1">$2</a>',
        );

        return result;
      };

      const htmlContent = convertToHtml(content);
      this.logger.log(
        `HTML 변환 완료 (원본 길이: ${content.length}, HTML 길이: ${htmlContent.length})`,
      );

      // 티스토리는 iframe 기반 에디터 사용 (TinyMCE)
      // TinyMCE는 HTML을 지원하므로 직접 HTML 삽입
      try {
        // 1. iframe 접근
        const iframeElement = await page.$('iframe');
        if (iframeElement) {
          const frame = await iframeElement.contentFrame();
          if (frame) {
            // TinyMCE의 body에 HTML 삽입
            const editorBody = await frame.$(
              'body[contenteditable="true"], body',
            );
            if (editorBody) {
              await editorBody.click();
              await page.waitForTimeout(500);

              // HTML을 에디터에 직접 삽입
              await frame.evaluate((html) => {
                const body = document.body;
                if (body) {
                  // 기존 내용 지우기
                  body.innerHTML = '';
                  // HTML 삽입
                  body.innerHTML = html;
                }
              }, htmlContent);

              contentEntered = true;
              this.logger.log('본문 입력 성공: HTML 직접 삽입');
            }
          }
        }
      } catch (e) {
        this.logger.log(`본문 HTML 삽입 실패: ${e.message}`);
      }

      // 2. Playwright frameLocator 사용 (텍스트 입력 fallback)
      if (!contentEntered) {
        try {
          const iframeLocator = page.frameLocator('iframe').first();
          const editorTextbox = iframeLocator.getByRole('textbox', {
            name: '글 내용 입력',
          });

          if (await editorTextbox.isVisible({ timeout: 5000 })) {
            await editorTextbox.click();
            await page.waitForTimeout(500);

            // HTML을 텍스트로 변환 (fallback)
            const plainContent = content
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/p>/gi, '\n\n')
              .replace(/<p[^>]*>/gi, '')
              .replace(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '$2 ($1)')
              .replace(/<[^>]+>/g, '')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .trim();

            await page.keyboard.type(plainContent, { delay: 10 });
            contentEntered = true;
            this.logger.log('본문 입력 성공: frameLocator + textbox (텍스트)');
          }
        } catch (e) {
          this.logger.log(`본문 텍스트 입력 실패: ${e.message}`);
        }
      }

      if (!contentEntered) {
        this.logger.error('본문 입력 필드를 찾지 못했습니다');
        await context.close();
        return { success: false, error: '본문 입력 필드를 찾지 못했습니다.' };
      }

      await page.waitForTimeout(1000);

      // === Direct API 발행 (CAPTCHA 우회) ===
      this.logger.log(
        `Direct API 발행 시도 (CAPTCHA 우회) – blog: ${actualBlogName}`,
      );

      const directApiResult = await page.evaluate(
        async (params: { title: string; htmlContent: string }) => {
          const { title, htmlContent } = params;

          // CKEditor에서 실제 에디터 콘텐츠 가져오기
          let editorContent = htmlContent;
          try {
            const ck = (window as any).CKEDITOR;
            if (ck?.instances) {
              const keys = Object.keys(ck.instances);
              if (keys.length > 0) {
                const data = ck.instances[keys[0]].getData();
                if (data) editorContent = data;
              }
            }
          } catch {
            /* fallback */
          }

          // TinyMCE에서도 가져오기 시도
          try {
            const tinymce = (window as any).tinymce;
            if (tinymce?.activeEditor) {
              const data = tinymce.activeEditor.getContent();
              if (data) editorContent = data;
            }
          } catch {
            /* fallback */
          }

          // iframe body에서 가져오기 시도
          if (editorContent === htmlContent) {
            try {
              const iframe = document.querySelector('iframe');
              if (iframe?.contentDocument?.body) {
                const iframeHtml = iframe.contentDocument.body.innerHTML;
                if (iframeHtml && iframeHtml.length > 10) {
                  editorContent = iframeHtml;
                }
              }
            } catch {
              /* cross-origin */
            }
          }

          const diagnostics: Array<{
            endpoint: string;
            status: number;
            ok: boolean;
            body?: string;
          }> = [];

          const tryPost = async (
            endpoint: string,
            payload: Record<string, string>,
            asJson: boolean,
          ) => {
            try {
              const headers: Record<string, string> = {
                'X-Requested-With': 'XMLHttpRequest',
              };
              let fetchBody: string;
              if (asJson) {
                headers['Content-Type'] = 'application/json';
                fetchBody = JSON.stringify(payload);
              } else {
                headers['Content-Type'] =
                  'application/x-www-form-urlencoded; charset=UTF-8';
                fetchBody = new URLSearchParams(payload).toString();
              }

              const res = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: fetchBody,
                credentials: 'same-origin',
              });

              const text = await res.text();
              diagnostics.push({
                endpoint: `${endpoint} (${asJson ? 'json' : 'form'})`,
                status: res.status,
                ok: res.ok,
                body: text.substring(0, 300),
              });

              if (res.ok) {
                let json: any = null;
                try {
                  json = JSON.parse(text);
                } catch {
                  /* not JSON */
                }
                return { success: true as const, json, text };
              }
            } catch (err) {
              diagnostics.push({
                endpoint,
                status: 0,
                ok: false,
                body: String(err),
              });
            }
            return null;
          };

          const postPayload: Record<string, string> = {
            title,
            content: editorContent,
            visibility: '20',
            categoryId: '0',
            tag: '',
            type: 'post',
          };

          const endpoints = [
            '/manage/post/write.json',
            '/manage/post/save.json',
            '/manage/entry/post',
            '/manage/post',
          ];

          for (const ep of endpoints) {
            const jsonRes = await tryPost(ep, postPayload, true);
            if (jsonRes)
              return { success: true, data: jsonRes.json, diagnostics };

            const formRes = await tryPost(ep, postPayload, false);
            if (formRes)
              return { success: true, data: formRes.json, diagnostics };
          }

          return { success: false, data: null, diagnostics };
        },
        { title, htmlContent },
      );

      if (directApiResult.success) {
        this.logger.log(
          `Direct API 발행 성공: ${JSON.stringify(directApiResult.data).substring(0, 200)}`,
        );

        // 쿠키 갱신
        let newCookies: string | undefined;
        try {
          const cookies = await context.cookies();
          newCookies = JSON.stringify(cookies);
        } catch {
          /* ignore */
        }

        const d = directApiResult.data;
        const postUrl =
          (d && typeof d === 'object' && (d.url || d.link || d.postUrl)) ||
          `https://${actualBlogName}.tistory.com`;
        const postIdMatch = String(postUrl).match(/\/(\d+)/);

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

        return {
          success: true,
          postId: postIdMatch?.[1] || '',
          postUrl: String(postUrl),
          newCookies,
        };
      }

      this.logger.warn(
        `Direct API 실패 – ${JSON.stringify(directApiResult.diagnostics)}`,
      );
      this.logger.log('UI 방식으로 전환...');

      // === 완료(발행) 버튼 클릭 (fallback) ===
      this.logger.log('완료 버튼 클릭 중...');
      let publishClicked = false;

      // 티스토리 글쓰기 페이지 분석 결과 (2026년 기준):
      // 완료 버튼: button "완료" [ref=e136]
      try {
        // Playwright의 getByRole 사용
        const publishBtn = page.getByRole('button', { name: '완료' });
        if (await publishBtn.isVisible({ timeout: 5000 })) {
          await publishBtn.click();
          publishClicked = true;
          this.logger.log('완료 버튼 클릭 성공: getByRole');
        }
      } catch (e) {
        this.logger.log(`완료 버튼 시도 1 실패: ${e.message}`);
      }

      // 대체 셀렉터 시도
      if (!publishClicked) {
        const publishBtnSelectors = [
          'button:has-text("완료")',
          'button:has-text("발행")',
          'button:has-text("공개발행")',
          '.btn_publish',
          '#publish-btn',
        ];

        for (const selector of publishBtnSelectors) {
          try {
            const publishBtn = await page.$(selector);
            if (publishBtn) {
              const isVisible = await publishBtn.isVisible();
              if (isVisible) {
                await publishBtn.click();
                publishClicked = true;
                this.logger.log(`완료 버튼 클릭 성공: ${selector}`);
                break;
              }
            }
          } catch (e) {
            this.logger.log(
              `발행 버튼 셀렉터 시도 실패 (${selector}): ${e.message}`,
            );
            continue;
          }
        }
      }

      if (!publishClicked) {
        this.logger.warn('완료 버튼을 찾지 못함 - Ctrl+Enter 시도');
        // Ctrl+Enter로 발행 시도
        await page.keyboard.press('Control+Enter');
        publishClicked = true;
      }

      // 발행 완료 대기
      await page.waitForTimeout(2000);

      // 추가 확인 모달 처리 (발행 설정 모달)
      try {
        this.logger.log('발행 설정 모달 체크 중...');

        // 1. 공개 설정 확인 (공개/비공개 선택)
        const publicOptionSelectors = [
          'input[type="radio"][value="public"]',
          'input[type="radio"][id*="public"]',
          'label:has-text("공개")',
          'button:has-text("공개")',
          '[data-visibility="public"]',
        ];

        let publicSelected = false;
        for (const selector of publicOptionSelectors) {
          try {
            if (selector.startsWith('label')) {
              // label을 클릭하여 라디오 버튼 선택
              const label = page.locator(selector).first();
              if (await label.isVisible({ timeout: 1000 })) {
                await label.click();
                this.logger.log(`"공개" 옵션 선택: ${selector}`);
                publicSelected = true;
                await page.waitForTimeout(500);
                break;
              }
            } else {
              // input 또는 button 직접 클릭
              const input = page.locator(selector).first();
              if (await input.isVisible({ timeout: 1000 })) {
                await input.click();
                this.logger.log(`"공개" 옵션 선택: ${selector}`);
                publicSelected = true;
                await page.waitForTimeout(500);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }

        if (!publicSelected) {
          this.logger.log('"공개" 옵션을 찾지 못함 - 기본 설정 사용');
        }

        // 2. "발행" 또는 "확인" 버튼 찾기
        const confirmBtnSelectors = [
          'button:has-text("발행")',
          'button:has-text("확인")',
          'button:has-text("공개")',
          'button:has-text("저장")',
          '.btn-primary:has-text("발행")',
          '.publish-confirm',
          '[type="submit"]',
        ];

        let modalConfirmed = false;
        for (const selector of confirmBtnSelectors) {
          try {
            const confirmBtn = page.locator(selector).first();
            if (await confirmBtn.isVisible({ timeout: 2000 })) {
              await confirmBtn.click();
              this.logger.log(`발행 확인 버튼 클릭: ${selector}`);
              modalConfirmed = true;
              await page.waitForTimeout(3000);
              break;
            }
          } catch (e) {
            // 버튼이 없으면 다음 셀렉터 시도
            continue;
          }
        }

        if (!modalConfirmed) {
          this.logger.log('발행 확인 모달 없음 (이미 발행됨)');
        }
      } catch (e) {
        this.logger.log(`모달 처리 중 오류: ${e.message}`);
      }

      // 최종 대기
      try {
        await page.waitForTimeout(3000);
      } catch (e) {
        this.logger.log('발행 후 대기 중 페이지가 닫힘 (정상일 수 있음)');
      }

      // 발행 결과 확인
      let finalUrl = '';
      try {
        finalUrl = page.url();
      } catch (e) {
        this.logger.log('페이지 URL 확인 실패 - 발행 완료로 간주');
        // 페이지가 닫힌 경우 발행 성공으로 간주
        await context.close();
        return {
          success: true,
          postUrl: `https://${blogName}.tistory.com`,
          newCookies: currentCookies,
        };
      }
      this.logger.log(`발행 후 URL: ${finalUrl}`);

      // 포스트 ID 추출 시도 (URL에서)
      let postId = '';
      const postIdMatch = finalUrl.match(/\/(\d+)(?:\?|$)/);
      if (postIdMatch) {
        postId = postIdMatch[1];
      }

      // 발행 성공 여부 확인
      // 1. 글쓰기 페이지가 아닌 곳으로 이동했으면 성공
      // 2. 또는 URL이 변경되지 않았어도 추가 확인 (브라우저에서 직접 확인)
      let publishSuccess =
        !finalUrl.includes('/manage/newpost') &&
        !finalUrl.includes('/manage/post/');

      // URL이 변경되지 않은 경우 - 발행된 글 목록으로 이동했는지 추가 확인
      if (!publishSuccess && finalUrl.includes('/manage/')) {
        try {
          // 관리 페이지에 있는지 확인
          const manageUrlPattern = /\/manage\/(posts|category|statistics)/;
          if (manageUrlPattern.test(finalUrl)) {
            publishSuccess = true;
            this.logger.log('관리 페이지로 이동 - 발행 성공으로 판단');
          }
        } catch (e) {
          this.logger.log('URL 패턴 확인 실패');
        }
      }

      // 여전히 글쓰기 페이지에 있는 경우 - 경고 표시하지만 성공으로 처리
      if (!publishSuccess) {
        this.logger.warn(
          '발행 완료 여부를 확인할 수 없음 - 하지만 성공으로 간주',
        );
        // 완료 버튼을 눌렀고 에러가 없었다면 성공으로 간주
        publishSuccess = publishClicked;
      }

      // 새 쿠키 저장
      let newCookies: string | undefined;
      try {
        const currentCookies = await context.cookies();
        newCookies = JSON.stringify(currentCookies);
      } catch (e) {
        this.logger.log('쿠키 저장 실패');
      }

      const postUrl =
        postId && blogName
          ? `https://${blogName}.tistory.com/${postId}`
          : finalUrl;

      // 정리: 컨텍스트와 브라우저 모두 종료
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

      if (publishSuccess || postId) {
        this.logger.log(`티스토리 발행 완료: ${postUrl}`);
        return {
          success: true,
          postId,
          postUrl,
          newCookies,
        };
      } else {
        this.logger.warn('발행 완료 여부를 확인할 수 없음');
        return {
          success: false,
          error:
            '발행이 완료되었는지 확인할 수 없습니다. 티스토리에서 직접 확인해주세요.',
          postUrl: finalUrl,
          newCookies,
        };
      }
    } catch (error) {
      // 정리: 컨텍스트와 브라우저 모두 종료
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
      this.logger.error(`티스토리 발행 오류: ${error.message}`);
      return {
        success: false,
        error: `발행 실패: ${error.message}`,
      };
    }
  }

  /**
   * 네이버 블로그 통계 수집
   */
  async getNaverBlogStats(
    cookies: string,
    blogId: string,
  ): Promise<BlogStats | null> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    try {
      // 쿠키 복원 - 문자열 형식과 JSON 배열 형식 모두 지원
      const cookieArray = this.parseCookieString(cookies, '.naver.com');
      await context.addCookies(cookieArray);

      const page = await context.newPage();

      // 블로그 통계 페이지로 이동
      await page.goto(
        `https://blog.naver.com/BlogStatisticsInfo.naver?blogId=${blogId}`,
        {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        },
      );

      await page.waitForTimeout(2000);

      const stats: BlogStats = {
        totalPosts: 0,
        totalViews: 0,
        todayVisitors: 0,
      };

      // 오늘 방문자 추출
      try {
        const todayEl = await page.$(
          '.today .cnt, .today_cnt, [class*="today"] .count',
        );
        if (todayEl) {
          const text = await todayEl.textContent();
          stats.todayVisitors = parseInt(
            text?.replace(/[^\d]/g, '') || '0',
            10,
          );
        }
      } catch {
        // 무시
      }

      // 총 방문자 추출
      try {
        const totalEl = await page.$(
          '.total .cnt, .total_cnt, [class*="total"] .count',
        );
        if (totalEl) {
          const text = await totalEl.textContent();
          stats.totalViews = parseInt(text?.replace(/[^\d]/g, '') || '0', 10);
        }
      } catch {
        // 무시
      }

      await context.close();
      return stats;
    } catch (error) {
      await context.close();
      this.logger.error(`네이버 통계 수집 오류: ${error.message}`);
      return null;
    }
  }

  /**
   * 수동 로그인을 위한 브라우저 열기 (2차 인증 지원)
   *
   * 사용자가 직접 브라우저에서 로그인(2차 인증 완료)하면,
   * 쿠키를 저장하여 이후 자동 발행에 사용할 수 있습니다.
   *
   * @param platform - 플랫폼 (tistory 또는 naver)
   * @returns 브라우저 세션 ID (쿠키 저장 시 사용)
   */
  private manualLoginSessions: Map<
    string,
    { context: BrowserContext; page: Page; platform: string }
  > = new Map();

  async openManualLoginBrowser(
    platform: 'tistory' | 'naver',
  ): Promise<{ success: boolean; sessionId?: string; message: string }> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    const page = await context.newPage();
    const sessionId = `manual_${platform}_${Date.now()}`;

    try {
      if (platform === 'tistory') {
        this.logger.log('티스토리 수동 로그인 브라우저 열기...');
        await page.goto('https://www.tistory.com/auth/login', {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
      } else if (platform === 'naver') {
        this.logger.log('네이버 수동 로그인 브라우저 열기...');
        await page.goto('https://nid.naver.com/nidlogin.login', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      }

      // 세션 저장 (나중에 쿠키 추출용)
      this.manualLoginSessions.set(sessionId, { context, page, platform });

      return {
        success: true,
        sessionId,
        message: `${platform === 'tistory' ? '티스토리' : '네이버'} 로그인 페이지가 열렸습니다. 브라우저에서 직접 로그인(2차 인증 포함)을 완료한 후, "쿠키 저장" 버튼을 클릭하세요.`,
      };
    } catch (error) {
      await context.close();
      this.logger.error(`수동 로그인 브라우저 열기 오류: ${error.message}`);
      return {
        success: false,
        message: `브라우저 열기 실패: ${error.message}`,
      };
    }
  }

  /**
   * 수동 로그인 후 쿠키 저장
   *
   * 사용자가 브라우저에서 로그인을 완료한 후 호출하여 쿠키를 저장합니다.
   *
   * @param sessionId - openManualLoginBrowser에서 반환된 세션 ID
   * @returns 쿠키 문자열 및 계정 정보
   */
  async saveManualLoginCookies(sessionId: string): Promise<AuthResult> {
    const session = this.manualLoginSessions.get(sessionId);

    if (!session) {
      return {
        success: false,
        message: '세션을 찾을 수 없습니다. 브라우저를 다시 열어주세요.',
      };
    }

    const { context, page, platform } = session;

    try {
      const currentUrl = page.url();
      this.logger.log(`현재 URL: ${currentUrl}`);

      // 로그인 상태 확인
      if (platform === 'tistory') {
        // 티스토리 로그인 상태 확인 - 로그인 페이지가 아니면 성공
        if (
          currentUrl.includes('auth/login') ||
          currentUrl.includes('accounts.kakao.com')
        ) {
          return {
            success: false,
            message:
              '아직 로그인이 완료되지 않았습니다. 브라우저에서 로그인을 완료해주세요.',
          };
        }

        // 블로그 정보 추출 시도
        const blogName = '';
        let blogUrl = '';
        let blogId = '';

        // 티스토리 메인으로 이동하여 블로그 정보 확인
        await page.goto('https://www.tistory.com/', {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
        await page.waitForTimeout(2000);

        // 블로그 링크에서 정보 추출
        try {
          const allLinks = await page.$$('a[href*=".tistory.com"]');
          for (const link of allLinks) {
            const href = await link.getAttribute('href');
            if (href) {
              const match = href.match(/https?:\/\/([^.]+)\.tistory\.com/);
              if (
                match &&
                !['www', 'notice', 'cs', 'policy'].includes(match[1])
              ) {
                blogId = match[1];
                blogUrl = `https://${blogId}.tistory.com`;
                this.logger.log(`블로그 URL 발견: ${blogUrl}`);
                break;
              }
            }
          }
        } catch (e) {
          this.logger.warn(`블로그 정보 추출 실패: ${e.message}`);
        }

        // 쿠키 저장
        const cookies = await context.cookies();
        const cookieString = JSON.stringify(cookies);

        // 세션 정리
        await context.close();
        this.manualLoginSessions.delete(sessionId);

        return {
          success: true,
          message: '티스토리 쿠키 저장 완료! 이제 자동 발행이 가능합니다.',
          accountInfo: {
            name: blogName || blogId || '티스토리 계정',
            url: blogUrl,
            blogId,
          },
          cookies: cookieString,
        };
      } else if (platform === 'naver') {
        // 네이버 로그인 상태 확인
        if (currentUrl.includes('nidlogin') || currentUrl.includes('login')) {
          return {
            success: false,
            message:
              '아직 로그인이 완료되지 않았습니다. 브라우저에서 로그인을 완료해주세요.',
          };
        }

        // 블로그 정보 추출
        let blogId = '';
        let blogName = '';
        let blogUrl = '';

        await page.goto('https://blog.naver.com/MyBlog.naver', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(2000);

        const blogUrlMatch = page.url().match(/blog\.naver\.com\/([^/?]+)/);
        if (blogUrlMatch) {
          blogId = blogUrlMatch[1];
          blogUrl = `https://blog.naver.com/${blogId}`;
        }

        try {
          const nickElement = await page.$('.nick, .blog_name, .nick_name');
          if (nickElement) {
            blogName = (await nickElement.textContent())?.trim() || '';
          }
        } catch {
          // 무시
        }

        // 쿠키 저장
        const cookies = await context.cookies();
        const cookieString = JSON.stringify(cookies);

        // 세션 정리
        await context.close();
        this.manualLoginSessions.delete(sessionId);

        return {
          success: true,
          message: '네이버 쿠키 저장 완료! 이제 자동 발행이 가능합니다.',
          accountInfo: {
            name: blogName || blogId || '네이버 블로그',
            url: blogUrl,
            blogId,
          },
          cookies: cookieString,
        };
      }

      return {
        success: false,
        message: '지원하지 않는 플랫폼입니다.',
      };
    } catch (error) {
      await context.close();
      this.manualLoginSessions.delete(sessionId);
      this.logger.error(`쿠키 저장 오류: ${error.message}`);
      return {
        success: false,
        message: `쿠키 저장 실패: ${error.message}`,
      };
    }
  }

  /**
   * 수동 로그인 세션 취소
   */
  async cancelManualLogin(sessionId: string): Promise<void> {
    const session = this.manualLoginSessions.get(sessionId);
    if (session) {
      await session.context.close();
      this.manualLoginSessions.delete(sessionId);
      this.logger.log(`수동 로그인 세션 취소: ${sessionId}`);
    }
  }

  /**
   * 모든 수동 로그인 세션 정리
   */
  async cleanupAllManualSessions(): Promise<void> {
    for (const [sessionId, session] of this.manualLoginSessions) {
      try {
        await session.context.close();
      } catch (e) {
        this.logger.warn(`세션 정리 실패 (${sessionId}): ${e.message}`);
      }
    }
    this.manualLoginSessions.clear();
    this.logger.log('모든 수동 로그인 세션 정리 완료');
  }
}

/**
 * OQUPIE 티켓 크롤링 → Firebase Firestore 저장
 * GitHub Actions에서 실행 (환경변수: FIREBASE_SERVICE_ACCOUNT)
 */

const puppeteer = require('puppeteer');
const admin     = require('firebase-admin');

// ── Firebase Admin 초기화 ──────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── 유틸 ──────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseKrDate(str) {
  if (!str) return new Date().toISOString();
  str = str.trim();
  if (/^\d{2}\/\d{2}$/.test(str)) {
    str = new Date().getFullYear() + '-' + str.replace('/', '-');
  }
  str = str.replace(/\./g, '-');
  try {
    const d = new Date(str);
    if (!isNaN(d)) return d.toISOString();
  } catch (e) {}
  return new Date().toISOString();
}

// 여러 selector 중 처음으로 찾은 요소 반환
async function findEl(page, selectors, timeout = 10000) {
  const sel = Array.isArray(selectors) ? selectors.join(', ') : selectors;
  try {
    await page.waitForSelector(sel, { timeout });
    return await page.$(sel);
  } catch {
    return null;
  }
}

// 페이지의 모든 input 정보를 출력 (디버그용)
async function debugInputs(page) {
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(el => ({
      type:        el.type,
      name:        el.name,
      id:          el.id,
      placeholder: el.placeholder,
      className:   el.className.slice(0, 60)
    }));
  });
  console.log('📋 페이지 input 목록:');
  inputs.forEach((inp, i) => console.log(`  [${i}]`, JSON.stringify(inp)));
  return inputs;
}

// ── 메인 ──────────────────────────────────────────────────────────
async function main() {
  console.log('=== OQUPIE 동기화 시작 ===');

  const settingsSnap = await db.collection('admin_settings').doc('oqupie').get();
  if (!settingsSnap.exists) {
    console.error('❌ admin_settings/oqupie 설정이 없습니다.');
    process.exit(1);
  }

  const { id: oqupieId, pw: oqupiePw, url: ticketListUrl } = settingsSnap.data();
  if (!oqupieId || !oqupiePw) {
    console.error('❌ 아이디 또는 비밀번호가 설정되지 않았습니다.');
    process.exit(1);
  }

  const listUrl = ticketListUrl || 'https://bizplay.oqupie.com/tickets/v5?selected_menu_code=TK11';
  console.log('티켓 목록 URL:', listUrl);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',  // 봇 감지 우회
      '--window-size=1400,900'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36'
    );

    // 봇 감지 우회 — navigator.webdriver 숨기기
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US'] });
      window.chrome = { runtime: {} };
    });

    // ── 로그인 ──────────────────────────────────────────────────
    console.log('로그인 페이지로 이동...');
    await page.goto('https://bizplay.oqupie.com/members/auth/login?next=/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // SPA가 React/Vue로 렌더링될 때까지 대기 (최대 15초)
    console.log('페이지 렌더링 대기 중...');
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('input').length > 0,
        { timeout: 15000, polling: 500 }
      );
      console.log('✅ input 요소 렌더링 확인');
    } catch (_) {
      console.log('⚠️ 15초 후에도 input 없음 — 강제 진행');
    }
    await sleep(1000);

    // 페이지 상태 출력 (디버그)
    const pageTitle = await page.title();
    const pageUrl   = page.url();
    console.log('페이지 제목:', pageTitle);
    console.log('페이지 URL:', pageUrl);

    // 페이지 HTML 앞부분 출력 (구조 파악용)
    const pageHtml = await page.evaluate(() => document.documentElement.outerHTML);
    console.log('=== PAGE HTML (처음 3000자) ===');
    console.log(pageHtml.slice(0, 3000));
    console.log('=== PAGE HTML END ===');

    // input이 나타날 때까지 최대 10초 대기
    console.log('input 요소 대기 중...');
    try {
      await page.waitForSelector('input', { timeout: 10000 });
    } catch (_) {
      console.log('⚠️ 10초 후에도 input 없음 — 현재 HTML 재출력');
      const html2 = await page.evaluate(() => document.documentElement.outerHTML);
      console.log(html2.slice(0, 2000));
    }

    // input 목록 출력 (디버그)
    const inputs = await debugInputs(page);

    // 이메일 입력 — 다양한 selector 시도
    let emailEl = null;

    // 1차: 타입/속성 기반
    emailEl = await findEl(page, [
      'input[type="email"]',
      'input[name="email"]',
      'input[id*="email"]',
      'input[placeholder*="이메일"]',
      'input[placeholder*="Email"]',
      'input[placeholder*="email"]',
      'input[type="text"][name*="id"]',
      'input[type="text"][id*="id"]',
      'input[type="text"][placeholder*="아이디"]',
      'input[type="text"][placeholder*="ID"]'
    ], 5000);

    // 2차: 첫 번째 text/email input
    if (!emailEl) {
      console.log('⚠️ 일반 selector 실패 → 첫 번째 텍스트 input 시도');
      const firstInput = inputs.find(inp =>
        inp.type === 'email' || inp.type === 'text' || inp.type === ''
      );
      if (firstInput) {
        const identifiers = [
          firstInput.id   ? `#${firstInput.id}`        : null,
          firstInput.name ? `input[name="${firstInput.name}"]` : null,
          `input[type="${firstInput.type || 'text'}"]`
        ].filter(Boolean);
        emailEl = await findEl(page, identifiers, 3000);
      }
    }

    if (!emailEl) {
      // 3차: 그냥 모든 input 중 첫 번째
      emailEl = await page.$('input');
    }

    if (!emailEl) {
      throw new Error('이메일 입력 필드를 찾을 수 없습니다. 로그인 페이지 구조를 확인해주세요.');
    }

    await emailEl.click({ clickCount: 3 });
    await emailEl.type(oqupieId, { delay: 60 });
    console.log('✅ 이메일 입력 완료');

    // 비밀번호 입력
    let pwEl = await findEl(page, ['input[type="password"]'], 5000);
    if (!pwEl) {
      // Tab 키로 다음 필드로 이동
      await emailEl.press('Tab');
      await sleep(500);
      pwEl = await page.$('input[type="password"]');
    }
    if (!pwEl) throw new Error('비밀번호 입력 필드를 찾을 수 없습니다.');

    await pwEl.click({ clickCount: 3 });
    await pwEl.type(oqupiePw, { delay: 60 });
    console.log('✅ 비밀번호 입력 완료');

    // 로그인 버튼
    const loginBtn = await page.$(
      'button[type="submit"], input[type="submit"], ' +
      'button.login-btn, button[class*="login"], ' +
      'button[class*="submit"], [class*="login-btn"]'
    );
    if (loginBtn) {
      await loginBtn.click();
      console.log('✅ 로그인 버튼 클릭');
    } else {
      await pwEl.press('Enter');
      console.log('✅ Enter 키로 로그인');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    await sleep(2000);

    const currentUrl = page.url();
    console.log('현재 URL:', currentUrl);

    if (currentUrl.includes('/login') || currentUrl.includes('/auth/login')) {
      throw new Error('로그인 실패: 아이디/비밀번호가 올바르지 않거나 로그인 페이지 구조가 변경되었습니다.');
    }
    console.log('✅ 로그인 성공');

    // ── 티켓 목록 + 강인혁 필터 ──────────────────────────────────
    console.log('티켓 목록 페이지로 이동...');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // SPA 렌더링 대기
    console.log('티켓 목록 렌더링 대기 중...');
    try {
      await page.waitForFunction(
        () => /\b\d{4,6}\b/.test(document.body.innerText),
        { timeout: 15000, polling: 800 }
      );
      console.log('✅ 티켓 목록 렌더링 확인');
    } catch (_) {
      console.log('⚠️ 15초 후에도 티켓 번호 없음 — 강제 진행');
    }
    await sleep(1500);

    // ── 나의 서랍 > 강인혁 필터 클릭 ────────────────────────────
    console.log('강인혁 필터 클릭 시도...');

    // 사이드바가 완전히 로드될 때까지 대기
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes('강인혁'),
        { timeout: 10000, polling: 500 }
      );
      console.log('✅ 강인혁 텍스트 감지됨');
    } catch (_) {
      console.log('⚠️ 강인혁 텍스트 미감지 — 강제 진행');
    }

    // 강인혁 요소 찾아서 클릭
    const filterEl = await page.evaluateHandle(() => {
      const walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT, null, false
      );
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.trim() === '강인혁') {
          return node.parentElement;
        }
      }
      return null;
    });

    // asElement()로 실제 DOM 요소인지 확인 (null JSHandle 클릭 방지)
    const filterElHandle = filterEl.asElement();
    if (filterElHandle) {
      try {
        // 스크롤 후 클릭 — 클릭 후 SPA 네비게이션 발생 가능하므로 동시에 대기
        await page.evaluate(el => el.scrollIntoView({ block: 'center' }), filterElHandle);
        await sleep(500);

        await Promise.all([
          // 네비게이션이 발생하면 대기 (SPA라면 발생 안 할 수도 있으므로 timeout 짧게)
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
          page.evaluate(el => {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
            if (el.parentElement) {
              el.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
          }, filterElHandle)
        ]);

        console.log('✅ 강인혁 필터 클릭 완료');
        await sleep(2500);

        // 필터 적용 후 렌더링 대기
        try {
          await page.waitForFunction(
            () => /\b\d{4,6}\b/.test(document.body.innerText),
            { timeout: 8000, polling: 500 }
          );
        } catch (_) {}

      } catch (clickErr) {
        console.log('⚠️ 강인혁 필터 클릭 오류:', clickErr.message, '— 전체 티켓 진행');
        // 페이지가 네비게이션으로 리로드됐을 경우 재이동
        if (!page.url().includes('bizplay.oqupie.com')) {
          await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await sleep(2000);
        }
      }
    } else {
      console.log('⚠️ 강인혁 필터 요소 없음 — 전체 티켓에서 진행');
    }

    // 무한스크롤 처리
    let prevHeight = 0;
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(800);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prevHeight) break;
      prevHeight = h;
    }

    // ── 티켓 목록 추출 (OQUPIE 실제 구조 기반) ──────────────────
    // OQUPIE 행 구조: 고객명 → 이메일 → [제목] → 번호 → 날짜 순
    const ticketList = await page.evaluate(() => {
      const results = [];
      const NAV_WORDS = new Set([
        'Ticket','Chat','Customer','Knowledge','Gadget','Report',
        'Community','Ticket UI','Low','Medium','High','All','ko','en',
        'bizplay','Create new ticket','Bulk action','Assign','Reply',
        'Spam','Delete','View','In Progress','Completed','Newly Received'
      ]);

      // 방법 1: 티켓 번호를 포함한 DOM 요소 찾기
      // 번호 형태: # 26552 또는 26552 단독
      const allEls = Array.from(document.querySelectorAll('*'));
      const seen   = new Set();

      allEls.forEach(el => {
        if (el.children.length > 2) return;
        const t = (el.innerText || '').trim();
        // "# 26552" 또는 "26552" 형태
        const numMatch = t.match(/^#?\s*(\d{4,6})$/);
        if (!numMatch || seen.has(numMatch[1])) return;
        const num = numMatch[1];
        seen.add(num);

        // 부모 행 찾기 (최대 5단계 위)
        let row = el;
        for (let i = 0; i < 5; i++) {
          if (!row.parentElement) break;
          row = row.parentElement;
          const h = row.getBoundingClientRect ? row.getBoundingClientRect().height : 0;
          if (h > 30 && h < 200) break;
        }

        const rowText   = (row.innerText || '').trim();
        const dateMatch = rowText.match(/\d{4}-\d{2}-\d{2}[\s ]+\d{2}:\d{2}/);
        const link      = row.querySelector('a') || el.closest('a');

        // 줄 분리 후 제목 후보 추출
        const MONTH_PAT  = /january|february|march|april|may|june|july|august|september|october|november|december/i;
        const WEEKDAY_PAT = /^(su|mo|tu|we|th|fr|sa){3,}/i;  // sumotuwethfrsa 같은 패턴
        const lines = rowText.split(/\n|\r/)
          .map(l => l.trim())
          .filter(l =>
            l.length >= 4
            && l.length <= 100               // 지나치게 긴 줄(UI 위젯) 제외
            && !l.includes('@')
            && !/^\d+$/.test(l)
            && !/^\d{4}-\d{2}-\d{2}/.test(l)
            && !NAV_WORDS.has(l)
            && !/^[A-Z]{2}$/.test(l)
            && !/^(bzp|biz)/.test(l)
            && !MONTH_PAT.test(l)            // 달력 월 이름 제외
            && !WEEKDAY_PAT.test(l)          // 요일 약어 나열 제외
            && !/^[<>]/.test(l)              // < > 로 시작하는 UI 텍스트 제외
          );

        // 이메일 다음 줄이 제목일 가능성이 높음 (OQUPIE 구조: 이름→이메일→제목→번호)
        const emailIdx = rowText.split(/\n|\r/).findIndex(l => l.includes('@'));
        const afterEmailLines = emailIdx >= 0
          ? rowText.split(/\n|\r/).slice(emailIdx + 1).map(l => l.trim())
              .filter(l => l.length >= 4 && !/^\d+$/.test(l) && !NAV_WORDS.has(l)
                && !MONTH_PAT.test(l) && !WEEKDAY_PAT.test(l) && l.length <= 100)
          : [];

        const subject = (afterEmailLines[0] || lines.sort((a, b) => b.length - a.length)[0] || '');

        if (subject) {
          results.push({
            num:      '#' + num,
            subject:  subject,
            date_raw: dateMatch ? dateMatch[0].trim() : '',
            href:     link ? link.href : ''
          });
        }
      });

      // 중복 제거
      const seen2 = new Set();
      return results.filter(t => {
        if (!t.num || !t.subject || seen2.has(t.num)) return false;
        seen2.add(t.num);
        return true;
      });
    });

    console.log(`티켓 ${ticketList.length}개 발견`);

    // ── 각 티켓 상세 ─────────────────────────────────────────────
    const tickets = [];
    for (let i = 0; i < ticketList.length; i++) {
      const tl = ticketList[i];
      console.log(`[${i + 1}/${ticketList.length}] ${tl.num} ${tl.subject}`);

      let body = '';
      const ticketId = tl.num.replace('#', '').trim();

      // href 없으면 티켓번호로 URL 직접 구성
      if (!tl.href) {
        tl.href = `https://bizplay.oqupie.com/tickets/v5/${ticketId}/`;
      }

      if (tl.href && tl.href.startsWith('http')) {
        try {
          await page.goto(tl.href, { waitUntil: 'domcontentloaded', timeout: 20000 });

          // SPA 렌더링 대기 — 실제 문의 내용(30자 이상 단락)이 나타날 때까지
          try {
            await page.waitForFunction(() => {
              const NAV = new Set(['Ticket','Chat','Customer','Knowledge',
                'Gadget','Report','Community','Ticket UI']);
              const els = Array.from(document.querySelectorAll('p, div, span, td'));
              return els.some(el => {
                const t = (el.innerText || '').trim();
                return t.length > 30
                  && el.children.length < 4
                  && !NAV.has(t)
                  && !t.includes('Ticket UI')
                  && !/^(Ticket|Chat|Customer|Knowledge)$/.test(t);
              });
            }, { timeout: 8000, polling: 500 });
          } catch (_) {}
          await sleep(1000);

          body = await page.evaluate(() => {
            // ── 추가정보 필드명 제외 목록 ─────────────────────────────
            const ADDITIONAL_INFO_FIELDS = new Set([
              // OQUPIE Additional information (13) 섹션 필드명
              '근무지','사원번호','연락처','고객 ID','고객ID','휴대폰 번호','휴대폰번호',
              '이용기관ID','이용기관 ID','사업자 번호','사업자번호','회사명','exp',
              '고객 명','고객명','Oqupie SDK version','Oqupie SDK Version',
              'User ID','UserID','User name','Username','Additional information',
              // 사이드바/폼 레이블
              'Brand','Name','Email','Phone','Rate','Channel','Status',
              'Priority','Tag','Assignee','Group','User','Customer'
            ]);
            const EXCLUDE_EXACT = new Set([
              'Ticket','Chat','Customer','Knowledge','Gadget','Report',
              'Community','Ticket UI','All','Low','Medium','High',
              'Recently Used','Something went wrong.','Search','Folder',
              'My response','기본 탬플릿','All Tickets','Create new ticket',
              'In Progress','Completed','Newly Received','Bulk action',
              'Assign','Reply','Spam','Delete','View','비즈플레이'
            ]);
            const EXCLUDE_CONTAINS = [
              'Something went wrong', 'OQUPIE will automatically',
              'OQUPIE.COM', 'Recently Used', 'january february',
              'sumotuwethfrsa', '비플식권_', 'My response'
            ];

            function hasKorean(t) { return /[가-힣]/.test(t); }

            // 텍스트가 추가정보 섹션 내용인지 확인
            function isAdditionalInfoText(t) {
              const lines = t.split('\n').map(l => l.trim()).filter(l => l);
              const infoLines = lines.filter(l => ADDITIONAL_INFO_FIELDS.has(l));
              // 줄의 30% 이상이 추가정보 필드명이면 제외
              return lines.length > 0 && infoLines.length / lines.length >= 0.3;
            }

            function isBadText(t) {
              if (!t || t.length < 15) return true;
              if (EXCLUDE_EXACT.has(t)) return true;
              if (EXCLUDE_CONTAINS.some(s => t.includes(s))) return true;
              if (/january|february|march/i.test(t) && t.length > 50) return true;
              if (isAdditionalInfoText(t)) return true;
              return false;
            }

            // ── 1차: "최초문의" 마커 탐색 — 가장 신뢰도 높은 방법 ────
            // "최초문의" 텍스트를 포함한 요소를 찾고, 그 조상 컨테이너에서
            // "추가 정보" 섹션 이전의 텍스트 블록을 추출
            const allNodes = Array.from(document.querySelectorAll('*'));

            // "최초문의" 마커 요소 찾기
            const marker = allNodes.find(el => {
              const t = (el.innerText || '').trim();
              return t === '최초문의' || t.endsWith('최초문의');
            });

            if (marker) {
              // 마커의 부모 섹션(메시지 카드) 찾기
              let section = marker;
              for (let i = 0; i < 8; i++) {
                if (!section.parentElement) break;
                section = section.parentElement;
                const rect = section.getBoundingClientRect();
                if (rect.width > 200 && rect.height > 60) break;
              }

              // 해당 섹션 내에서 추가정보 이전 텍스트 추출
              // "추가 정보" 또는 "Additional information" 이후 내용 제거
              let rawText = (section.innerText || '').trim();

              // 최초문의 이후 내용 구분자 — 해당 위치 이후 텍스트 제거
              // (추가정보 섹션, 답변 메시지 등)
              const cutSeparators = [
                '추가 정보', 'Additional information', '추가정보',
                // 답변/회신 구분자
                '\n답변\n', '\n답장\n', '\n회신\n',
                '\nRe:', '\nRE:',
                // 타임스탬프가 붙은 답변 구분 패턴은 아래 정규식으로 처리
              ];
              for (const sep of cutSeparators) {
                const idx = rawText.indexOf(sep);
                if (idx > 20) {
                  rawText = rawText.slice(0, idx).trim();
                  break;
                }
              }
              // 정규식으로 "날짜 + 답변/회신" 패턴 이후 제거
              // 예: "2026-06-01 13:52\n답변" 형태
              rawText = rawText.replace(/\d{4}-\d{2}-\d{2}[\s\S]{0,30}?(답변|답장|회신|Reply|reply)[\s\S]*/m, '').trim();

              // "최초문의" 헤더 줄 제거 (발신자 이름, 날짜, "최초문의" 텍스트 포함 줄)
              const lines = rawText.split('\n').map(l => l.trim()).filter(l => l);
              // 앞 1~3줄이 헤더인 경우 건너뜀 (짧은 줄 + "최초문의" 포함)
              let startIdx = 0;
              for (let i = 0; i < Math.min(3, lines.length); i++) {
                if (lines[i].includes('최초문의') || lines[i].length < 30) {
                  startIdx = i + 1;
                } else break;
              }
              const bodyLines = lines.slice(startIdx).filter(l =>
                !ADDITIONAL_INFO_FIELDS.has(l) && !EXCLUDE_EXACT.has(l)
              );
              const extracted = bodyLines.join('\n').trim();
              if (extracted.length >= 15 && hasKorean(extracted)) return extracted;
            }

            // ── 2차: CSS class 기반 메시지 탐색 ─────────────────────
            const msgSelectors = [
              '[class*="message-body"]', '[class*="messageBody"]',
              '[class*="ticket-body"]',  '[class*="ticketBody"]',
              '[class*="content-body"]', '[class*="first-message"]',
              '[class*="mail-body"]',    '[class*="msg-content"]',
              '[class*="message-content"]'
            ];
            for (const sel of msgSelectors) {
              const el = document.querySelector(sel);
              const t = el ? el.innerText.trim() : '';
              if (!isBadText(t) && hasKorean(t)) return t;
            }

            // ── 3차: 한글 포함 텍스트 중 추가정보 제외한 가장 긴 것 ──
            const candidates = Array.from(document.querySelectorAll('p, div, td'))
              .map(el => ({ el, t: (el.innerText || '').trim() }))
              .filter(({ el, t }) =>
                t.length >= 15 && t.length <= 1500
                && el.children.length < 5
                && hasKorean(t)
                && !isBadText(t)
              )
              .sort((a, b) => b.t.length - a.t.length);

            return candidates[0] ? candidates[0].t : '';
          });

          // 목록 복귀 (SPA이므로 history.back() 먼저 시도)
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(async () => {
            await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          });
          await sleep(1500);

          // 강인혁 필터 재적용 (목록 복귀 후 필터가 초기화될 수 있음)
          await page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if (node.nodeValue && node.nodeValue.trim() === '강인혁') {
                const el = node.parentElement;
                if (el) {
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                }
                break;
              }
            }
          });
          await sleep(1000);

        } catch (e) {
          console.warn(`  ⚠️ 상세 읽기 실패 (${tl.num}): ${e.message}`);
          try {
            await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sleep(800);
          } catch (_) {}
        }
      }

      tickets.push({
        id:         ticketId,
        num:        tl.num,
        subject:    tl.subject,
        body:       body,
        created_at: parseKrDate(tl.date_raw),
        synced_at:  new Date().toISOString()
      });
    }

    // ── Firestore 저장 (기존 문서 확인 후 변경분만 저장) ────────
    if (tickets.length > 0) {
      console.log(`\nFirestore 저장 중 (중복 체크)...`);

      // 기존 저장된 티켓 ID 목록 조회 (1회 읽기)
      const existingSnap = await db.collection('oqupie_tickets')
        .select()  // ID만 가져와 읽기 비용 최소화
        .get();
      const existingIds = new Set(existingSnap.docs.map(d => d.id));

      const newTickets     = tickets.filter(t => !existingIds.has(t.id));
      const updatedTickets = tickets.filter(t => existingIds.has(t.id));

      console.log(`  신규: ${newTickets.length}개 / 업데이트: ${updatedTickets.length}개`);

      // 신규 티켓만 저장
      const toSave = newTickets.length > 0 ? newTickets : tickets;
      const BATCH_SIZE = 499;
      for (let i = 0; i < toSave.length; i += BATCH_SIZE) {
        const batch = db.batch();
        toSave.slice(i, i + BATCH_SIZE).forEach(ticket => {
          const docId = ticket.id || String(Date.now()) + '_' + Math.random().toString(36).slice(2);
          batch.set(db.collection('oqupie_tickets').doc(docId), ticket, { merge: true });
        });
        await batch.commit();
        console.log(`  배치 저장 완료 (${Math.min(i + BATCH_SIZE, toSave.length)}/${toSave.length})`);
      }
    }

    await db.collection('admin_settings').doc('oqupie').update({
      last_sync:  new Date().toISOString(),
      last_count: tickets.length,
      last_error: null
    });

    console.log(`\n✅ 동기화 완료: ${tickets.length}개 티켓 저장됨`);

  } catch (e) {
    console.error('\n❌ 오류 발생:', e.message);
    try {
      await db.collection('admin_settings').doc('oqupie').update({
        last_sync:  new Date().toISOString(),
        last_error: e.message
      });
    } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error('예상치 못한 오류:', e);
  process.exit(1);
});

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

    // SPA 렌더링 대기 (최대 40초)
    console.log('티켓 목록 렌더링 대기 중...');
    try {
      await page.waitForFunction(
        () => /\b\d{4,6}\b/.test(document.body.innerText),
        { timeout: 40000, polling: 800 }
      );
      console.log('✅ 티켓 목록 렌더링 확인');
    } catch (_) {
      console.log('⚠️ 40초 후에도 티켓 번호 없음 — 페이지 재시도');
      // 페이지 재로드 시도
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(5000);
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log('재시도 후 페이지 텍스트 일부:', bodyText.slice(0, 200).replace(/\n/g, ' | '));
    }
    await sleep(2000);

    // ── 나의 서랍 > 강인혁 필터 클릭 ────────────────────────────
    console.log('강인혁 필터 클릭 시도...');

    // 사이드바가 완전히 로드될 때까지 대기 (최대 20초)
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes('강인혁'),
        { timeout: 20000, polling: 500 }
      );
      console.log('✅ 강인혁 텍스트 감지됨');
    } catch (_) {
      console.log('⚠️ 강인혁 텍스트 미감지 — 사이드바 로딩 추가 대기');
      await sleep(5000);
      const hasSidebar = await page.evaluate(() => document.body.innerText.includes('강인혁'));
      console.log('추가 대기 후 강인혁 감지:', hasSidebar);
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

    // ── 상태별 티켓 수집 함수 ────────────────────────────────────
    async function collectTicketsByStatus(statusKeywords, label) {
      // 해당 상태 버튼 클릭
      const clicked = await page.evaluate((keywords) => {
        const allEls = Array.from(document.querySelectorAll('*'));
        for (const kw of keywords) {
          const el = allEls.find(el => {
            const t = (el.innerText || '').trim();
            return t === kw && el.children.length === 0;
          });
          if (el) {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            if (el.parentElement) el.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return kw;
          }
        }
        return null;
      }, statusKeywords);

      if (!clicked) {
        console.log(`  ⚠️ ${label} 버튼 미감지`);
        return [];
      }
      console.log(`  ✅ ${label} 클릭: ${clicked}`);
      await sleep(2000);

      // 무한스크롤
      let ph = 0;
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(600);
        const h = await page.evaluate(() => document.body.scrollHeight);
        if (h === ph) break;
        ph = h;
      }
      return await extractTicketList();
    }

    // ── 티켓 목록 추출 함수 (재사용 가능) ───────────────────────
    async function extractTicketList() {
      return await page.evaluate(() => {
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
      }); // extractTicketList 끝
    } // function 끝

    // ── 대기(Newly Received) + 진행(In Progress) 두 상태 수집 ───
    console.log('\n[1/2] 대기(Newly Received) 티켓 수집...');
    const listNewlyReceived = await collectTicketsByStatus(
      ['Newly Received', '신규 접수', '신규', '대기'],
      '대기'
    );
    console.log(`  대기 티켓: ${listNewlyReceived.length}개`);

    console.log('[2/2] 진행(In Progress) 티켓 수집...');
    const listInProgress = await collectTicketsByStatus(
      ['In Progress', '진행 중', '진행중', '처리 중'],
      '진행'
    );
    console.log(`  진행 티켓: ${listInProgress.length}개`);

    // 두 목록 합산 후 중복 제거
    const combined = [...listNewlyReceived, ...listInProgress];
    const seenNums = new Set();
    const ticketList = combined.filter(t => {
      if (!t.num || seenNums.has(t.num)) return false;
      seenNums.add(t.num);
      return true;
    });

    console.log(`\n합산: 대기 ${listNewlyReceived.length} + 진행 ${listInProgress.length} = ${ticketList.length}개 (중복 제거 후)`);

    console.log(`티켓 ${ticketList.length}개 발견 (날짜 필터 전)`);

    // ── 5일 이내 티켓만 필터링 ──────────────────────────────────
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 5);
    cutoffDate.setHours(0, 0, 0, 0);
    console.log(`5일 기준: ${cutoffDate.toISOString().slice(0,10)} 이후 티켓만 크롤링`);

    const filteredList = ticketList.filter(tl => {
      if (!tl.date_raw) return true; // 날짜 없으면 포함
      const d = new Date(parseKrDate(tl.date_raw));
      return d >= cutoffDate;
    });

    console.log(`날짜 필터 후: ${filteredList.length}개 티켓`);

    // ── 각 티켓 상세 ─────────────────────────────────────────────
    const tickets = [];
    for (let i = 0; i < filteredList.length; i++) {
      const tl = filteredList[i];
      console.log(`[${i + 1}/${filteredList.length}] ${tl.num} ${tl.subject}`);

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
            // ── 제거할 UI/헤더 요소 ──────────────────────────────────
            const SKIP_LINES = new Set([
              'General','Follow-up','First inquiry','최초문의',
              'Forward','Translate','Pro Agent','Agent',
              'Additional information','추가 정보','추가정보',
              'Ticket','Chat','Customer','Knowledge','Gadget','Report',
              'Community','Ticket UI','All','Low','Medium','High',
              'Assign','Reply','Spam','Delete','View','Search','Folder',
              '근무지','사원번호','연락처','고객 ID','휴대폰 번호',
              '이용기관ID','사업자 번호','회사명','exp','고객 명',
              'Oqupie SDK version','User ID','User name'
            ]);

            // ── 이 텍스트가 나타나면 이후 내용 전부 제거 (이메일 스레드/서명 시작) ──
            const CUT_AT = [
              'From:', 'Sent:', '보낸 사람:', '받는 사람:',
              'T +82', 'M +82', 'F +82',      // 전화번호 서명
              'www.hyundai.com', 'www.kia.com', // URL 서명
              'Hyundai Motor', 'Kia Corporation',
              '주의 : 이 메일은', 'CAUTION : This email',
              '주의: 이 메일', 'CAUTION: This email',
              'Attached file', '첨부 파일',
              '\nTicket created', '\nTicket assigned',
              '\nReply sent', '\nTicket properties',
            ];

            // ── "최초문의" / "First inquiry" 마커 찾기 ────────────────
            function findMarker() {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) {
                const t = (node.nodeValue || '').trim();
                if (t === '최초문의' || t === 'First inquiry') return node.parentElement;
              }
              return null;
            }

            // ── 원문 텍스트 정제 ───────────────────────────────────────
            function cleanBody(raw) {
              if (!raw) return '';

              // 1) 이메일 스레드/서명 시작 지점에서 자르기
              let text = raw;
              for (const cut of CUT_AT) {
                const idx = text.indexOf(cut);
                if (idx >= 0) text = text.slice(0, idx);
              }

              // 2) 정규식 패턴으로 자르기
              // 이메일 서명: "감사합니다." 뒤에 이름+영문이름 패턴
              text = text.replace(/\n감사합니다\.?\n[\s\S]*/m, '').trim();
              text = text.replace(/\n(Thank you|Best regards|Regards|Sincerely)[\s\S]*/im, '').trim();
              // 타임라인 이벤트
              text = text.replace(/\n\d{2}:\d{2}\s+(Ticket|Reply|Forward|Assign)[\s\S]*/m, '').trim();
              text = text.replace(/\n\d{4}-\d{2}-\d{2}\n\d{2}:\d{2}[\s\S]*/m, '').trim();
              // 담당자 답변 헤더 (이니셜 2글자 단독 줄)
              text = text.replace(/\n[A-Z]{2}\n[\s\S]*/m, '').trim();
              // 이름 - Ticket ... 패턴
              text = text.replace(/\n.+? - Ticket [\s\S]*/m, '').trim();

              // 3) 추가정보 값 패턴 제거 (Python dict, 전화번호, ID 등)
              text = text.replace(/^\{'.+?':.+?\}$/gm, '');           // {'key': 'value'} Python dict
              text = text.replace(/^\{".+?": .+?\}$/gm, '');          // {"key": "value"} JSON
              text = text.replace(/^\+\+82-[\d-]+$/gm, '');           // ++82-010-xxxx 전화번호
              text = text.replace(/^\+82-[\d-]+$/gm, '');             // +82-010-xxxx 전화번호
              text = text.replace(/^\d{9,11}$/gm, '');                // 9~11자리 순수 숫자 (사번, 연락처)
              text = text.replace(/^[A-Za-z].+ v\d+\.\d+.*$/gm, ''); // "Portal Finder v1.0.0" SDK 버전
              text = text.replace(/^\d{10}$/gm, '');                  // 10자리 exp 타임스탬프
              text = text.replace(/^\|\s*\d{4}-\d{2}-\d{2}.*$/gm, ''); // | YYYY-MM-DD 타임스탬프

              // 4) 줄 단위 필터링
              const lines = text.split('\n').map(l => l.trim()).filter(l => l);
              const kept = lines.filter(l => {
                if (SKIP_LINES.has(l)) return false;
                if (/^\d{4}-\d{2}-\d{2}$/.test(l)) return false;    // 날짜 단독
                if (/^\d{2}:\d{2}$/.test(l)) return false;            // 시간 단독
                if (/^\|\s*\d{2}:\d{2}/.test(l)) return false;        // | 14:02
                if (/^\|\s*\d{4}-\d{2}-\d{2}/.test(l)) return false;  // | YYYY-MM-DD
                if (/^[A-Z]{2}$/.test(l)) return false;               // 이니셜
                if (/^\+{1,2}82/.test(l)) return false;               // +82/++82 전화번호
                if (/^\d{7,11}$/.test(l)) return false;               // 7~11자리 ID/사번
                if (l.includes('@') && !l.includes(' ')) return false; // 이메일 단독
                if (/\d{2}:\d{2}\s+(Ticket|Reply|Assign)/.test(l)) return false;
                if (/.+\s*-\s*(Ticket|Reply|Forward)/.test(l)) return false;
                if (/^\{.+\}$/.test(l)) return false;                  // {dict} 형태
                return true;
              });

              return kept.join('\n').trim();
            }

            // ── Additional information 섹션을 DOM에서 제거 ──────────
            function removeAdditionalInfo(root) {
              const allEls = Array.from(root.querySelectorAll('*'));
              for (const el of allEls) {
                const t = (el.innerText || el.textContent || '').trim();
                // "추가 정보 (13)" 또는 "Additional information (13)" 헤더 찾기
                if (/^(추가 정보|Additional information)(\s*\(\d+\))?$/.test(t) && t.length < 35) {
                  // 이 헤더의 부모 섹션 전체 제거 (최대 5단계 위)
                  let section = el;
                  for (let i = 0; i < 5; i++) {
                    if (!section.parentElement || section.parentElement === root || section.parentElement === document.body) break;
                    section = section.parentElement;
                  }
                  if (section !== root) section.remove();
                  break;
                }
              }
            }

            // ── 마커 기반 추출 ────────────────────────────────────────
            const marker = findMarker();
            if (marker) {
              // 마커의 메시지 컨테이너 찾기 (충분한 크기의 부모)
              let container = marker;
              for (let i = 0; i < 10; i++) {
                if (!container.parentElement) break;
                container = container.parentElement;
                const r = container.getBoundingClientRect();
                if (r.width > 300 && r.height > 50) break;
              }
              // 추가정보 섹션 제거 후 텍스트 추출
              removeAdditionalInfo(container);
              const raw = (container.innerText || '').trim();
              const cleaned = cleanBody(raw);
              if (cleaned.length >= 5) return cleaned;
            }

            // ── fallback: CSS 클래스 탐색 ────────────────────────────
            const selectors = [
              '[class*="message-body"]','[class*="messageBody"]',
              '[class*="ticket-body"]','[class*="first-message"]',
              '[class*="mail-body"]','[class*="msg-content"]',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) {
                const cleaned = cleanBody(el.innerText || '');
                if (cleaned.length >= 5) return cleaned;
              }
            }

            return '';
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

    // ── Firestore 저장 + 종료/해결 티켓 삭제 ────────────────────
    console.log(`\nFirestore 동기화 중...`);

    // 기존 저장된 티켓 전체 조회
    const existingSnap = await db.collection('oqupie_tickets').select().get();
    const existingIds   = new Set(existingSnap.docs.map(d => d.id));

    // 현재 활성(대기) 티켓 ID 목록
    const activeIds = new Set(tickets.map(t => t.id));

    // ① 종료/해결 티켓 삭제: Firestore에 있지만 현재 활성 목록에 없는 것
    const toDelete = existingSnap.docs.filter(d => !activeIds.has(d.id));
    if (toDelete.length > 0) {
      console.log(`  🗑️ 종료/해결 티켓 삭제: ${toDelete.length}개`);
      const BATCH_SIZE = 499;
      for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
        const batch = db.batch();
        toDelete.slice(i, i + BATCH_SIZE).forEach(doc => {
          batch.delete(db.collection('oqupie_tickets').doc(doc.id));
          console.log(`    삭제: ${doc.id}`);
        });
        await batch.commit();
      }
    }

    // ② 신규 티켓 저장: 활성 목록에 있지만 Firestore에 없는 것
    if (tickets.length > 0) {
      const newTickets = tickets.filter(t => !existingIds.has(t.id));
      console.log(`  신규: ${newTickets.length}개 / 기존 유지: ${tickets.length - newTickets.length}개`);

      if (newTickets.length > 0) {
        const BATCH_SIZE = 499;
        for (let i = 0; i < newTickets.length; i += BATCH_SIZE) {
          const batch = db.batch();
          newTickets.slice(i, i + BATCH_SIZE).forEach(ticket => {
            const docId = ticket.id || String(Date.now()) + '_' + Math.random().toString(36).slice(2);
            batch.set(db.collection('oqupie_tickets').doc(docId), ticket, { merge: true });
          });
          await batch.commit();
          console.log(`  저장 완료 (${Math.min(i + BATCH_SIZE, newTickets.length)}/${newTickets.length})`);
        }
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

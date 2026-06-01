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

    const filterElProp = await filterEl.getProperty('tagName').catch(() => null);
    if (filterElProp) {
      // 요소 위치로 스크롤 후 클릭
      await page.evaluate(el => {
        el.scrollIntoView({ block: 'center' });
      }, filterEl);
      await sleep(500);

      // dispatchEvent로 실제 클릭 이벤트 발생
      await page.evaluate(el => {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
        // 부모 요소도 클릭
        if (el.parentElement) {
          el.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
      }, filterEl);

      console.log('✅ 강인혁 필터 클릭 완료');
      await sleep(3000);

      // 필터 적용 후 페이지 텍스트 변화 확인
      const afterText = await page.evaluate(() => document.body.innerText.slice(0, 200));
      console.log('필터 적용 후 페이지 일부:', afterText.replace(/\n/g, ' | '));
    } else {
      console.log('⚠️ 강인혁 필터 요소 없음 — 전체 티켓에서 강인혁 담당 필터링');
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
            // 본문으로 볼 수 없는 텍스트 패턴
            const EXCLUDE_EXACT = new Set([
              'Ticket','Chat','Customer','Knowledge','Gadget','Report',
              'Community','Ticket UI','IH','All','Low','Medium','High',
              'Recently Used','Something went wrong.'
            ]);
            const EXCLUDE_CONTAINS = [
              'Something went wrong',
              'OQUPIE will automatically',
              'OQUPIE.COM',
              'Recently Used',
              'january february',
              'sumotuwethfrsa'
            ];

            function isBadText(t) {
              if (!t) return true;
              if (EXCLUDE_EXACT.has(t)) return true;
              if (EXCLUDE_CONTAINS.some(s => t.includes(s))) return true;
              // 달력/요일 UI 패턴
              if (/january|february|march/i.test(t) && t.length > 50) return true;
              return false;
            }

            // 1차: 메시지/본문 class 직접 탐색
            const msgSelectors = [
              '[class*="message-body"]', '[class*="messageBody"]',
              '[class*="ticket-body"]',  '[class*="ticketBody"]',
              '[class*="content-body"]', '[class*="first-message"]',
              '[class*="mail-body"]',    '[class*="msg-content"]',
              '[class*="message-content"]', '[class*="description"]',
              'article'
            ];
            for (const sel of msgSelectors) {
              const el = document.querySelector(sel);
              const t = el ? el.innerText.trim() : '';
              if (t.length > 20 && !isBadText(t)) return t;
            }

            // 2차: 텍스트 블록 중 실제 문의 내용 찾기 (20~2000자, 나쁜 텍스트 제외)
            const candidates = Array.from(document.querySelectorAll('p, div, td'))
              .map(el => ({ el, t: (el.innerText || '').trim() }))
              .filter(({ el, t }) =>
                t.length >= 20
                && t.length <= 2000
                && el.children.length < 5
                && !isBadText(t)
                && !t.split('\n').every(line => EXCLUDE_EXACT.has(line.trim()))
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

    // ── Firestore 저장 ───────────────────────────────────────────
    if (tickets.length > 0) {
      console.log(`\nFirestore에 ${tickets.length}개 저장 중...`);
      const BATCH_SIZE = 499;
      for (let i = 0; i < tickets.length; i += BATCH_SIZE) {
        const batch = db.batch();
        tickets.slice(i, i + BATCH_SIZE).forEach(ticket => {
          const docId = ticket.id || String(Date.now()) + '_' + Math.random().toString(36).slice(2);
          batch.set(db.collection('oqupie_tickets').doc(docId), ticket, { merge: true });
        });
        await batch.commit();
        console.log(`  배치 저장 완료 (${Math.min(i + BATCH_SIZE, tickets.length)}/${tickets.length})`);
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

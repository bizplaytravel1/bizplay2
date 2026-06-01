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

    // ── 티켓 목록 ────────────────────────────────────────────────
    console.log('티켓 목록 페이지로 이동...');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // SPA 렌더링 대기 — 5자리 숫자(티켓번호) 패턴이 나타날 때까지
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
    await sleep(2000);

    // 무한스크롤 처리
    let prevHeight = 0;
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(800);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prevHeight) break;
      prevHeight = h;
    }

    // ── 티켓 목록 추출 (OQUPIE 실제 DOM 구조 기반) ──────────────
    const ticketList = await page.evaluate(() => {
      const results = [];

      // OQUPIE는 각 티켓을 클릭 가능한 행/카드로 렌더링
      // URL 패턴 /tickets/v5/{숫자} 로 링크를 찾음
      const ticketLinks = Array.from(
        document.querySelectorAll('a[href*="/tickets/"]')
      ).filter(a => /\/tickets\/[^/]*\/\d+/.test(a.href) || /\/tickets\/v\d+\/\d+/.test(a.href) || /\/tickets\/\d+/.test(a.href));

      if (ticketLinks.length > 0) {
        ticketLinks.forEach(a => {
          const numMatch = a.href.match(/\/(\d{4,6})\/?(?:\?|$|\/)/);
          if (!numMatch) return;
          const num     = numMatch[1];
          const rowEl   = a.closest('tr, li, [class*="row"], [class*="item"], [class*="card"]') || a;
          const rowText = rowEl.innerText || a.innerText || '';
          // 날짜 패턴 찾기
          const dateMatch = rowText.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/);
          // 제목: 첫 번째 긴 텍스트 줄 (이메일, 날짜, 짧은 단어 제외)
          const lines = rowText.split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 3
              && !l.includes('@')
              && !/^\d+$/.test(l)
              && !/\d{4}-\d{2}-\d{2}/.test(l)
              && !['Low','Medium','High','ko','en','bizplay','All'].includes(l)
            );
          const subject = lines[0] || '';
          if (num && subject) {
            results.push({
              num:      '#' + num,
              subject:  subject,
              date_raw: dateMatch ? dateMatch[0] : '',
              href:     a.href
            });
          }
        });
      }

      // fallback: 5자리 숫자 + 인근 텍스트로 추출
      if (results.length === 0) {
        const allEls = Array.from(document.querySelectorAll('*'));
        const seen   = new Set();
        allEls.forEach(el => {
          if (el.children.length > 0) return;
          const t = (el.innerText || '').trim();
          if (/^\d{4,6}$/.test(t) && !seen.has(t)) {
            seen.add(t);
            const parent = el.closest('tr, li, [class*="row"], [class*="item"]') || el.parentElement;
            const rowText = parent ? (parent.innerText || '') : '';
            const lines   = rowText.split('\n').map(l => l.trim()).filter(l =>
              l.length > 3 && !l.includes('@') && !/^\d+$/.test(l) && !/\d{4}-\d{2}-\d{2}/.test(l)
            );
            const subject  = lines[0] || '';
            const dateMatch = rowText.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/);
            const link      = parent ? parent.querySelector('a[href*="ticket"]') : null;
            if (subject) {
              results.push({
                num:      '#' + t,
                subject:  subject,
                date_raw: dateMatch ? dateMatch[0] : '',
                href:     link ? link.href : ''
              });
            }
          }
        });
      }

      // 중복 제거
      const seen2 = new Set();
      return results.filter(t => {
        if (!t.num || !t.subject || seen2.has(t.num)) return false;
        seen2.add(t.num);
        return true;
      });
    });

    console.log(`티켓 ${ticketList.length}개 발견`);

    if (ticketList.length === 0) {
      console.log('⚠️ 티켓이 없거나 페이지 구조를 인식하지 못했습니다.');
    }

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
          await page.goto(tl.href, { waitUntil: 'networkidle2', timeout: 20000 });
          await sleep(1200);

          body = await page.evaluate(() => {
            const selectors = [
              '[class*="message-body"]', '[class*="messageBody"]',
              '[class*="ticket-body"]',  '[class*="ticketBody"]',
              '[class*="content-body"]', '[class*="first-message"]',
              '[class*="description"]',  '.description',
              'article', '[role="main"] p'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && el.innerText && el.innerText.trim().length > 10) {
                return el.innerText.trim();
              }
            }
            const divs = Array.from(document.querySelectorAll('div, p'));
            const cand = divs.find(d =>
              d.innerText && d.innerText.trim().length > 50 && d.children.length < 5
            );
            return cand ? cand.innerText.trim() : '';
          });

          await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 20000 });
          await sleep(1000);
        } catch (e) {
          console.warn(`  ⚠️ 상세 읽기 실패 (${tl.num}): ${e.message}`);
          try {
            await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 20000 });
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

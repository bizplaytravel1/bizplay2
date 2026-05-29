/**
 * OQUPIE 티켓 크롤링 → Firebase Firestore 저장
 * GitHub Actions에서 실행 (환경변수: FIREBASE_SERVICE_ACCOUNT)
 */

const puppeteer   = require('puppeteer');
const admin       = require('firebase-admin');

// ── Firebase Admin 초기화 ──────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── 유틸 ──────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseKrDate(str) {
  // "2026.05.29" / "2026-05-29" / "05/29" 형태 → ISO 문자열
  if (!str) return new Date().toISOString();
  str = str.trim();
  // 올해 기준 단축 날짜 처리
  if (/^\d{2}\/\d{2}$/.test(str)) {
    str = new Date().getFullYear() + '-' + str.replace('/', '-');
  }
  str = str.replace(/\./g, '-');
  try {
    const d = new Date(str);
    if (!isNaN(d)) return d.toISOString();
  } catch(e) {}
  return new Date().toISOString();
}

// ── 메인 ──────────────────────────────────────────────────────────
async function main() {
  console.log('=== OQUPIE 동기화 시작 ===');

  // Firestore에서 OQUPIE 설정 읽기
  const settingsSnap = await db.collection('admin_settings').doc('oqupie').get();
  if (!settingsSnap.exists) {
    console.error('❌ admin_settings/oqupie 설정이 없습니다. 관리자 페이지 → OQUPIE 연동 설정에서 먼저 저장해주세요.');
    process.exit(1);
  }
  const { id: oqupieId, pw: oqupiePw, url: ticketListUrl } = settingsSnap.data();
  const listUrl = ticketListUrl || 'https://bizplay.oqupie.com/tickets/v5?selected_menu_code=TK11';

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

    // ── 로그인 ──────────────────────────────────────────────────
    console.log('로그인 중...');
    await page.goto('https://bizplay.oqupie.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1000);

    // 이메일 입력
    await page.waitForSelector('input[type="email"], input[name="email"], input[id*="email"], input[placeholder*="이메일"]', { timeout: 10000 });
    await page.click('input[type="email"], input[name="email"], input[id*="email"], input[placeholder*="이메일"]');
    await page.keyboard.type(oqupieId, { delay: 50 });

    // 비밀번호 입력
    await page.click('input[type="password"]');
    await page.keyboard.type(oqupiePw, { delay: 50 });

    // 로그인 버튼
    await page.click('button[type="submit"], input[type="submit"], .login-btn, [class*="login"][class*="btn"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(1500);

    const curUrl = page.url();
    if (curUrl.includes('login')) {
      throw new Error('로그인 실패: 아이디/비밀번호를 확인해주세요.');
    }
    console.log('✅ 로그인 성공');

    // ── 티켓 목록 페이지 ────────────────────────────────────────
    console.log('티켓 목록 페이지로 이동:', listUrl);
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // 페이지 하단까지 스크롤 (무한스크롤 대응)
    let prevHeight = 0;
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(800);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prevHeight) break;
      prevHeight = h;
    }

    // ── 티켓 목록 추출 ──────────────────────────────────────────
    const ticketList = await page.evaluate(() => {
      const results = [];

      // 방법 1: 테이블 행
      const rows = document.querySelectorAll('table tbody tr, [class*="ticket-row"], [class*="ticketRow"]');
      if (rows.length > 0) {
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          const allText = row.innerText || '';
          // #으로 시작하는 번호 찾기
          const numMatch = allText.match(/#(\d+)/);
          const numEl = row.querySelector('[class*="number"], [class*="id"]');
          const subjectEl = row.querySelector('[class*="subject"], [class*="title"], [class*="name"]');
          const dateEl = row.querySelector('[class*="date"], [class*="time"], [class*="created"]');
          const link = row.querySelector('a[href*="ticket"]');

          results.push({
            num: numMatch ? '#' + numMatch[1] : (numEl ? numEl.innerText.trim() : ''),
            subject: subjectEl ? subjectEl.innerText.trim() : (cells[1] ? cells[1].innerText.trim() : ''),
            date_raw: dateEl ? dateEl.innerText.trim() : '',
            href: link ? link.href : ''
          });
        });
      }

      // 방법 2: 카드형 목록
      if (results.length === 0) {
        const cards = document.querySelectorAll('[class*="ticket-item"], [class*="ticketItem"], [class*="ticket-card"]');
        cards.forEach(card => {
          const allText = card.innerText || '';
          const numMatch = allText.match(/#(\d+)/);
          const subjectEl = card.querySelector('[class*="subject"], [class*="title"], h3, h4, strong');
          const dateEl = card.querySelector('[class*="date"], [class*="time"], time');
          const link = card.querySelector('a') || card;

          results.push({
            num: numMatch ? '#' + numMatch[1] : '',
            subject: subjectEl ? subjectEl.innerText.trim() : '',
            date_raw: dateEl ? (dateEl.innerText || dateEl.getAttribute('datetime') || '').trim() : '',
            href: link.href || ''
          });
        });
      }

      return results.filter(t => t.num && t.subject);
    });

    console.log(`${ticketList.length}개 티켓 발견`);

    // ── 각 티켓 상세 내용 크롤링 ────────────────────────────────
    const tickets = [];
    for (let i = 0; i < ticketList.length; i++) {
      const tl = ticketList[i];
      console.log(`[${i+1}/${ticketList.length}] ${tl.num} ${tl.subject}`);

      let body = '';
      const ticketId = (tl.num || '').replace('#', '').trim();

      if (tl.href && tl.href.startsWith('http')) {
        try {
          await page.goto(tl.href, { waitUntil: 'networkidle2', timeout: 15000 });
          await sleep(1000);

          body = await page.evaluate(() => {
            // 첫 번째 문의 메시지 본문 추출
            const selectors = [
              '[class*="message-body"]', '[class*="messageBody"]',
              '[class*="ticket-body"]',  '[class*="ticketBody"]',
              '[class*="content-body"]', '[class*="first-message"]',
              '.description', '[class*="description"]',
              'article', '[role="main"] p'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && el.innerText.trim().length > 10) {
                return el.innerText.trim();
              }
            }
            // fallback: 첫 번째 긴 텍스트 블록
            const divs = Array.from(document.querySelectorAll('div, p'));
            const candidate = divs.find(d => d.innerText.trim().length > 50 && d.children.length < 5);
            return candidate ? candidate.innerText.trim() : '';
          });

          // 티켓 목록 페이지로 돌아가기
          await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 20000 });
          await sleep(1000);
        } catch (e) {
          console.log(`  ⚠️ 상세 읽기 실패: ${e.message}`);
        }
      }

      tickets.push({
        id: ticketId,
        num: tl.num,
        subject: tl.subject,
        body: body,
        created_at: parseKrDate(tl.date_raw),
        synced_at: new Date().toISOString()
      });
    }

    // ── Firebase Firestore에 저장 ────────────────────────────────
    console.log('Firebase에 저장 중...');
    const BATCH_SIZE = 500;
    for (let i = 0; i < tickets.length; i += BATCH_SIZE) {
      const batch = db.batch();
      tickets.slice(i, i + BATCH_SIZE).forEach(ticket => {
        const docId = ticket.id || String(Date.now()) + '_' + Math.random().toString(36).slice(2);
        const ref = db.collection('oqupie_tickets').doc(docId);
        batch.set(ref, ticket, { merge: true });
      });
      await batch.commit();
    }

    // 동기화 결과 업데이트
    await db.collection('admin_settings').doc('oqupie').update({
      last_sync: new Date().toISOString(),
      last_count: tickets.length,
      last_error: null
    });

    console.log(`\n✅ 동기화 완료: ${tickets.length}개 티켓 저장`);

  } catch (e) {
    console.error('❌ 오류:', e.message);
    try {
      await db.collection('admin_settings').doc('oqupie').update({
        last_sync: new Date().toISOString(),
        last_error: e.message
      });
    } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
    process.exit(0);
  }
}

main();

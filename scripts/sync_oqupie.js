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

async function waitFor(page, selector, timeout = 8000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return await page.$(selector);
  } catch {
    return null;
  }
}

// ── 메인 ──────────────────────────────────────────────────────────
async function main() {
  console.log('=== OQUPIE 동기화 시작 ===');

  const settingsSnap = await db.collection('admin_settings').doc('oqupie').get();
  if (!settingsSnap.exists) {
    console.error('❌ admin_settings/oqupie 설정이 없습니다. 관리자 페이지 → OQUPIE 연동 설정에서 먼저 저장해주세요.');
    process.exit(1);
  }

  const { id: oqupieId, pw: oqupiePw, url: ticketListUrl } = settingsSnap.data();
  if (!oqupieId || !oqupiePw) {
    console.error('❌ 아이디 또는 비밀번호가 Firestore에 저장되어 있지 않습니다.');
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

    // ── 로그인 ──────────────────────────────────────────────────
    console.log('로그인 페이지로 이동...');
    await page.goto('https://bizplay.oqupie.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await sleep(1500);

    const emailSel = [
      'input[type="email"]',
      'input[name="email"]',
      'input[id*="email"]',
      'input[placeholder*="이메일"]',
      'input[placeholder*="Email"]'
    ].join(', ');

    const emailEl = await waitFor(page, emailSel, 10000);
    if (!emailEl) throw new Error('이메일 입력 필드를 찾을 수 없습니다.');
    await emailEl.click({ clickCount: 3 });
    await emailEl.type(oqupieId, { delay: 60 });

    const pwEl = await waitFor(page, 'input[type="password"]', 5000);
    if (!pwEl) throw new Error('비밀번호 입력 필드를 찾을 수 없습니다.');
    await pwEl.click({ clickCount: 3 });
    await pwEl.type(oqupiePw, { delay: 60 });

    const loginBtn = await page.$('button[type="submit"], input[type="submit"], .login-btn');
    if (loginBtn) {
      await loginBtn.click();
    } else {
      await pwEl.press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    await sleep(2000);

    if (page.url().includes('login')) {
      throw new Error('로그인 실패: 아이디/비밀번호를 확인해주세요.');
    }
    console.log('✅ 로그인 성공 →', page.url());

    // ── 티켓 목록 ────────────────────────────────────────────────
    console.log('티켓 목록 페이지로 이동...');
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2500);

    let prevHeight = 0;
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(700);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prevHeight) break;
      prevHeight = h;
    }

    const ticketList = await page.evaluate(() => {
      const results = [];

      const rows = document.querySelectorAll(
        'table tbody tr, [class*="ticket-row"], [class*="ticketRow"]'
      );
      if (rows.length > 0) {
        rows.forEach(row => {
          const cells    = row.querySelectorAll('td');
          const allText  = row.innerText || '';
          const numMatch = allText.match(/#(\d+)/);
          const subjectEl = row.querySelector('[class*="subject"], [class*="title"], [class*="name"]');
          const dateEl    = row.querySelector('[class*="date"], [class*="time"], [class*="created"]');
          const link      = row.querySelector('a[href*="ticket"]');
          if (numMatch) {
            results.push({
              num:      '#' + numMatch[1],
              subject:  subjectEl ? subjectEl.innerText.trim() : (cells[1] ? cells[1].innerText.trim() : ''),
              date_raw: dateEl ? dateEl.innerText.trim() : '',
              href:     link ? link.href : ''
            });
          }
        });
      }

      if (results.length === 0) {
        const cards = document.querySelectorAll(
          '[class*="ticket-item"], [class*="ticketItem"], [class*="ticket-card"]'
        );
        cards.forEach(card => {
          const allText  = card.innerText || '';
          const numMatch = allText.match(/#(\d+)/);
          if (!numMatch) return;
          const subjectEl = card.querySelector('[class*="subject"], [class*="title"], h3, h4, strong');
          const dateEl    = card.querySelector('[class*="date"], [class*="time"], time');
          const link      = card.querySelector('a') || card;
          results.push({
            num:      '#' + numMatch[1],
            subject:  subjectEl ? subjectEl.innerText.trim() : '',
            date_raw: dateEl ? (dateEl.innerText || dateEl.getAttribute('datetime') || '').trim() : '',
            href:     link.href || ''
          });
        });
      }

      if (results.length === 0) {
        Array.from(document.querySelectorAll('a[href*="ticket"]')).forEach(a => {
          const text     = a.innerText || '';
          const numMatch = text.match(/#(\d+)/);
          if (numMatch) {
            results.push({
              num:      '#' + numMatch[1],
              subject:  text.replace(/#\d+/, '').trim(),
              date_raw: '',
              href:     a.href
            });
          }
        });
      }

      return results.filter(t => t.num && t.subject);
    });

    console.log(`티켓 ${ticketList.length}개 발견`);

    // ── 각 티켓 상세 ─────────────────────────────────────────────
    const tickets = [];
    for (let i = 0; i < ticketList.length; i++) {
      const tl = ticketList[i];
      console.log(`[${i + 1}/${ticketList.length}] ${tl.num} ${tl.subject}`);

      let body = '';
      const ticketId = tl.num.replace('#', '').trim();

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

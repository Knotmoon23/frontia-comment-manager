// ==UserScript==
// @name         프론티아 댓글 관리
// @namespace    frontia-comment-manager
// @version      2.3.0
// @description  내 작품의 금지어·어뷰징 댓글(온점·초성·같은 말 반복·맞팔 등) 자동 삭제. 한국어 화면 전용.
// @match        https://frontia.ai/*
// @updateURL    https://raw.githubusercontent.com/Knotmoon23/frontia-comment-manager/main/frontia-comment-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/Knotmoon23/frontia-comment-manager/main/frontia-comment-manager.user.js
// @run-at       document-idle
// @icon         https://raw.githubusercontent.com/Knotmoon23/frontia-comment-manager/main/icon.png
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

// 흐름: [정리 시작] → 첫 화면에서 내 프로필 주소 읽기 → 내 프로필에서 작품 목록 →
//       작품마다 댓글 창 열기 → 판정 → 걸린 것 바로 삭제 → 지운 건수
// 지우는 것은 금지어와 확실한 어뷰징뿐 (온점·초성·같은 말 반복·구걸·맞팔·흔적·도배). 물음표·칭찬·사진 댓글은 건드리지 않음.
// '지우기 전에 먼저 보기' 를 켜면 지우지 않고 걸린 댓글 글만 보여 줌.
// 작품을 옮겨 다니며 페이지가 새로 열리므로, 진행 상태는 저장소(fccl.job)에 두고 새 페이지에서 이어 간다.
// 읽기·삭제는 지휘소 엔진(src/frontia-comment-cleaner.user.js)에서 한국어 부분만 옮겨 온 것.

(function () {
  'use strict';
  if (window.top !== window.self) return;

  const VERSION = '2.3.0';
  const T = { deleteGap: 1800, idleWait: 10000, menuWait: 2000, reflectWait: 8000, finalCheckWait: 8000,
    perItemMax: 240000, blockedGap: 8000, scrollRounds: 40 };   // perItemMax: 사람이 [삭제]를 누르길 기다리는 3분보다 길게

  /* ---------- 저장소 · 설정 ---------- */
  const gmGet = (k, d) => {
    try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch (e) { /* 아래로 */ }
    try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; }
  };
  const gmSet = (k, v) => {
    try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; } } catch (e) { /* 아래로 */ }
    try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ }
  };
  const readJSON = (k, d) => { try { const v = gmGet(k, ''); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const writeJSON = (k, v) => gmSet(k, v == null ? '' : JSON.stringify(v));
  const SET_KEY = 'fccl.settings', JOB_KEY = 'fccl.job', LAST_KEY = 'fccl.last', AGREED_KEY = 'fccl.agreed';

  const PRESET_WORDS = ['맞팔', '선팔', '임무', '미션', '출석', '출첵', '1등', '1빠'];
  // works: 프로필에서 읽은 내 작품 [{id, title}] · offWorks: 체크를 끈 작품 id (새 작품은 켜진 채로 들어옴)
  const DEFAULTS = { maxAgeDays: 7, offTopicWords: PRESET_WORDS, previewFirst: false, works: [], offWorks: [] };
  let S = { ...DEFAULTS, ...readJSON(SET_KEY, {}) };
  const saveSettings = () => writeJSON(SET_KEY, S);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 기다리기는 항상 진짜 시계로 (숨은 탭에서는 타이머가 느려짐)
  async function waitFor(fn, ms, step = 250) {
    const until = Date.now() + ms;
    let v;
    while (!(v = fn()) && Date.now() < until) await sleep(step);
    return v || fn();
  }
  // 숨은 탭에서는 클릭이 씹힘 → 다시 볼 때까지 기다림
  async function waitVisible() {
    if (!document.hidden) return;
    status('탭으로 돌아오면 이어서 진행');
    await new Promise(res => {
      const h = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', h); res(); } };
      document.addEventListener('visibilitychange', h);
    });
    await sleep(1000);
  }

  /* ===================== 판정 (한국어) ===================== */
  // 지우는 것: 온점·기호만 · 초성만 · 같은 말 반복 · 금지어 · 구걸·맞팔 · 일일 임무 · 흔적만 · 도배
  // 물음표·사진이 있는 댓글은 판정 전에 뺌 (scan). 칭찬·질문·긴 글은 지우지 않음.
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const graphemes = s => seg ? [...seg.segment(s)].map(x => x.segment) : [...s];
  const norm = s => (s || '').replace(/\s+/g, '');
  const flat = s => norm(String(s || '')).toLowerCase();
  const SYMBOLS_ONLY = /^[\p{P}\p{S}\p{N}\p{M}\p{Cf}\p{Z}️]+$/u;

  // 긴 댓글(한글이 있으면 15자, 아니면 30자 이상)
  function isLong(body) {
    const t = (body || '').replace(/\p{Cf}/gu, '').trim().replace(/\s+/g, ' ');
    if (SYMBOLS_ONLY.test(t)) return false;
    return graphemes(t).length >= (/[가-힣]/.test(t) ? 15 : 30);
  }

  // 글 전체가 한 말의 되풀이 ('하하하' · '임무 임무' · '재밌다재밌다')
  function isRepeat(body) {
    const g = graphemes(String(body || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
    for (let p = 1; p * 2 <= g.length; p++) {
      if (g.length % p === 0 && g.every((x, i) => x === g[i % p])) return true;
    }
    return false;
  }

  // 금지어. '임무' 같은 흔한 말은 짧고 다른 말이 없는 댓글에서만
  const LOOSE_WORDS = ['임무', '미션', '출석'];
  const RE_WORD_NOT = /않|없|별로|근데|지만/;
  function wordReason(body) {
    const t = flat(body), plain = graphemes(t).length <= 20 && !RE_WORD_NOT.test(t);
    const hit = (S.offTopicWords || []).find(w => flat(w) && t.includes(flat(w)) && (plain || !LOOSE_WORDS.includes(w)));
    return hit ? '금지어 ' + hit : null;
  }

  // 구걸·홍보
  const BEG = [
    ['좋아요 구걸', /좋아요\s*\d+\s*개.{0,10}(임무|미션|업적)|(임무|미션|업적).{0,10}좋아요\s*\d+\s*개|좋아요\s*(임무|미션|업적)/],
    ['재화 구걸', /(스타|크레딧|재화|다이아|코인|포인트)\s*(좀\s*)?(주세요|줘|주실|주면|주시면|나눔|나눠|선물|보내|구걸|구함|구해요|받고\s*싶)|무료\s*(스타|크레딧)|(스타|크레딧)\s*(나눔|구걸)/],
    // '추천해 주세요' 는 작품 추천을 묻는 말일 수 있어 '추천' 은 누르는 말만
    ['좋아요 구걸', /(좋아요|하트)\s*(좀\s*)?(눌러|부탁|해\s*주|박아|꾹|주세요|줘|ㄱㄱ)|추천\s*(좀\s*)?(눌러|박아|꾹)|좋아요\s*구걸/],
    ['맞팔·홍보', /맞팔|선팔|(팔로우|팔로|구독)\s*(해|부탁|좀|ㄱ)|많관부|놀러\s*오세요|(제|내|저희)\s*(캐릭터|캐릭|작품|에피소드|에피|채널|프로필)\s*(도|좀)?\s*(봐|와|놀러|구경|들러|해\s*주|부탁|관심)|(초대|추천인|추천)\s*코드/],
  ];
  const begReason = body => { const t = (body || '').replace(/\s+/g, ' '); const hit = BEG.find(([, re]) => re.test(t)); return hit ? hit[0] : null; };

  // 일일 임무 하려고 단 짧은 글
  const RE_DAILY = /일일\s*(임무|미션|퀘스트)/;
  const dailyReason = body => RE_DAILY.test(body) && !isLong(body.replace(new RegExp(RE_DAILY.source, 'g'), ' ')) ? '보상용 댓글' : null;

  // '도장 꾹'·'찍고 갑니다' 뿐인 글
  const RE_TRACE = /도장\s*(꾹|찍)|찍고\s*(갑니다|감|가요)|다녀\s*갑니다|흔적\s*(남기|남겨)/g;
  function traceReason(body) {
    RE_TRACE.lastIndex = 0;
    if (isLong(body) || !RE_TRACE.test(body)) return null;
    const left = graphemes(norm(body.replace(RE_TRACE, ' ')).replace(/[\p{P}\p{S}\p{N}\p{M}\p{Cf}️~]/gu, ''));
    return left.length <= 4 ? '흔적만 남김' : null;
  }

  // 지울 까닭 (없으면 null)
  function judgeText(body) {
    const t = norm(body);
    if (!t || /[?？]/.test(t)) return null;
    if (SYMBOLS_ONLY.test(t)) return '온점·기호';
    const letters = t.replace(/[^\p{L}]/gu, '');
    if (/^[ㄱ-ㆎ]+$/.test(letters)) return '초성';
    if (isRepeat(t)) return '같은 말 반복';
    return begReason(body) || wordReason(body) || dailyReason(body) || traceReason(body);
  }

  // 도배: 같은 사람이 1시간 안에 짧은 같은 말을 3번 이상
  function markBurst(list) {
    const byUser = {};
    list.forEach(c => (byUser[c.groupKey] ||= []).push(c));
    Object.values(byUser).forEach(group => {
      if (group.length < 3) return;
      group.sort((a, b) => a.minutesAgo - b.minutesAgo);
      for (let i = 0; i + 2 < group.length; i++) {
        const win = group.filter(c => c.minutesAgo >= group[i].minutesAgo && c.minutesAgo - group[i].minutesAgo <= 60);
        if (win.length < 3 || !win.every(c => graphemes(norm(c.body)).length <= 12)) continue;
        const cnt = {};
        win.forEach(c => { const t = flat(c.body); cnt[t] = (cnt[t] || 0) + 1; });
        win.filter(c => cnt[flat(c.body)] >= 2 && !c.verdict).forEach(c => { c.verdict = '도배'; });
      }
    });
  }

  /* ===================== 화면에서 댓글 읽기 ===================== */
  const ROW_SEL = 'div.relative.flex.w-full.items-start';
  const visibleText = el => (el ? el.innerText || '' : '').trim();
  const isText = (el, ...words) => words.includes(visibleText(el));
  const commentPanel = () => [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
    .find(d => d.querySelector(ROW_SEL) || [...d.querySelectorAll('button')].some(b => isText(b, '최신'))) || null;
  const commentRoot = () => commentPanel() || document;
  const rowCount = () => commentRoot().querySelectorAll(ROW_SEL).length;
  // 답글은 원댓글 행 안에 같은 모양으로 들어가므로, 그 행에 직접 속한 요소만 고름
  const own = (row, sel) => [...row.querySelectorAll(sel)].filter(e => e.closest(ROW_SEL) === row);

  // 시간 글자 → 몇 분 전. 시간 글자가 아니면 null
  function parseTime(s) {
    s = s.trim();
    if (s === '방금 전') return 0;
    let m;
    const n = x => parseInt(x.replace(/,/g, ''), 10);
    if ((m = s.match(/^(\d[\d,]*)\s*분\s*전$/))) return n(m[1]);
    if ((m = s.match(/^(\d[\d,]*)\s*시간\s*전$/))) return n(m[1]) * 60;
    if ((m = s.match(/^(\d[\d,]*)\s*일\s*전$/))) return n(m[1]) * 1440;
    if ((m = s.match(/^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/))) {
      return Math.max(0, Math.round((Date.now() - new Date(+m[1], +m[2] - 1, +m[3]).getTime()) / 60000));
    }
    return null;
  }

  function parseRow(row) {
    const kebab = own(row, 'button.ml-auto')[0] || null;
    const link = own(row, 'a[href^="/users/profile/"]')[0];
    const timeP = own(row, 'p').find(e => { const t = visibleText(e); return t && parseTime(t) !== null; });
    if (!timeP) return null;
    const timeText = visibleText(timeP);
    const nameEl = own(row, 'a[href^="/users/profile/"]:not(.shrink-0)')[0] || own(row, 'p')[0];
    const bodyEl = own(row, 'div.whitespace-pre-line')[0];
    const body = bodyEl ? visibleText(bodyEl) : '';
    const pressBtn = own(row, 'button[aria-pressed]')[0];
    // 파트너 디렉터(이름 옆 파란 체크 배지)
    const nameLine = nameEl && nameEl.parentElement !== row ? nameEl.parentElement : null;
    const badge = !!link && !!nameLine && [...nameLine.children].some(e => e.tagName.toLowerCase() === 'svg');
    const images = [...new Set(own(row, 'img').filter(i => {
      const src = i.currentSrc || i.src || '';
      if (!/^https?:/.test(src)) return false;
      return /comment-image/.test(src) || (!/profile-image/.test(src) && !i.closest('a[href^="/users/profile/"]') && !i.closest('button'));
    }).map(i => i.currentSrc || i.src))].slice(0, 4);
    return {
      el: row, kebab,
      isReply: !!row.parentElement?.closest(ROW_SEL) || /pl-\[/.test(row.className) || parseFloat(getComputedStyle(row).paddingLeft) >= 40,
      isDirector: own(row, 'p,span,div').some(e => isText(e, '디렉터')),
      userId: link ? link.getAttribute('href').split('?')[0].split('/').pop() : null,
      name: visibleText(nameEl) || '(이름 없음)',
      timeText, minutesAgo: parseTime(timeText), body, images, badge,
      liked: !!pressBtn && pressBtn.getAttribute('aria-pressed') === 'true',
      removed: (!body && !images.length) || body.includes('삭제된 댓글입니다'),
    };
  }

  // 에피소드 화면의 「댓글 6 >」 머리 (제목 2개 = 이름·숫자). 글자가 달라도 모양으로 찾음
  function commentHeadBtn() {
    const cands = [...document.querySelectorAll('button')].filter(b => {
      if (b.closest('#fccl') || b.closest('[role="dialog"]')) return false;
      const hs = b.querySelectorAll('h1,h2,h3,h4');
      return hs.length === 2 && /^\d[\d,]*\+?$/.test(visibleText(hs[1]));
    });
    return cands.find(b => isText(b.querySelector('h1,h2,h3,h4'), '댓글')) || cands[0] || null;
  }
  const getTotalCount = () => {
    const h = [...document.querySelectorAll('h1,h2,h3,h4')].map(x => x.innerText.trim()).find(t => /^\d[\d,]*$/.test(t));
    return h ? parseInt(h.replace(/,/g, ''), 10) : null;
  };
  const viewAllBtn = () => [...document.querySelectorAll('button,a')].find(b => /^댓글\s*\d[\d,]*\s*개\s*더보기$/.test(visibleText(b)));

  // 댓글 창 열기. 결과: true / 'empty'(댓글 0개) / false(못 엶)
  // 주의: 에피소드 화면의 미리보기 댓글 5줄은 창이 열리기 전에 보이므로, 그것만 보고 진행하지 않음
  async function openComments() {
    if (!commentPanel()) {
      await waitFor(() => viewAllBtn() || commentPanel() || document.querySelectorAll(ROW_SEL).length > 5 ||
        (commentHeadBtn() && !document.querySelector(ROW_SEL)), 30000, 300);
      const head = !viewAllBtn() && !commentPanel() ? commentHeadBtn() : null;
      if (head && parseInt(visibleText(head.querySelectorAll('h1,h2,h3,h4')[1]).replace(/[,+]/g, ''), 10) === 0) return 'empty';
      if (!viewAllBtn() && !commentPanel() && !head) {
        if (getTotalCount() === 0) return 'empty';
        const n = document.querySelectorAll(ROW_SEL).length, total = getTotalCount();
        return n > 5 || (n > 0 && total !== null && n >= total);
      }
      for (let k = 0; k < 3 && !commentPanel(); k++) {
        const btn = viewAllBtn() || commentHeadBtn();
        if (!btn) break;
        realClick(btn);
        await waitFor(commentPanel, 8000, 300);
      }
    }
    const panel = commentPanel();
    if (!panel) return false;
    if (await waitCommentsReady()) return true;
    if (!panel.querySelector(ROW_SEL) && getTotalCount() === 0) return 'empty';
    return false;
  }

  // 스크롤할 상자: 댓글 창이 있으면 그 안에서만 (엉뚱한 화면을 스크롤하지 않게)
  function boxIn(el) {
    return [...el.querySelectorAll('div')]
      .filter(d => !d.closest('#fccl') && /(auto|scroll)/.test(getComputedStyle(d).overflowY) &&
        d.scrollHeight > d.clientHeight + 20 && d.clientHeight > 120)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
  }
  function getScrollBox() {
    const panel = commentPanel();
    if (panel) return boxIn(panel);
    const known = document.querySelector('div.flex-1.overflow-y-auto');
    if (known && known.scrollHeight > known.clientHeight) return known;
    return boxIn(document) || document.scrollingElement;
  }
  // 댓글 창에 줄이 보이고 스크롤 상자가 생기면 준비됨 (댓글이 몇 개뿐이면 줄 수가 1.5초 그대로일 때)
  async function waitCommentsReady(maxMs = 20000) {
    let lastN = -1, since = 0;
    return waitFor(() => {
      const panel = commentPanel();
      if (panel) {
        const n = panel.querySelectorAll(ROW_SEL).length;
        if (!n) return false;
        if (boxIn(panel)) return true;
        if (n !== lastN) { lastN = n; since = Date.now(); return false; }
        const still = Date.now() - since;
        return still >= 1500 && (!panel.querySelector('img[alt="loading-icon"]') || still >= 6000);
      }
      if (viewAllBtn()) return false;
      return rowCount() > 0 && !!getScrollBox();
    }, maxMs, 300);
  }

  // 기본 정렬이 '인기' → '최신' 으로. 글자로 못 찾으면 '나란한 작은 버튼 2개 중 둘째'
  function sortTabs() {
    const pairs = [...commentRoot().querySelectorAll('div')].filter(d => {
      if (d.closest('#fccl')) return false;
      const kids = [...d.children];
      return kids.length === 2 && kids.every(k => k.tagName === 'BUTTON' && visibleText(k) && visibleText(k).length <= 20 && !/\d/.test(visibleText(k)));
    });
    for (const d of pairs) {
      const kids = [...d.children];
      const newest = kids.find(k => isText(k, '최신')), popular = kids.find(k => isText(k, '인기'));
      if (newest) return { newest, popular: popular || kids.find(k => k !== newest) };
      if (popular) return { newest: kids.find(k => k !== popular), popular };
    }
    return pairs.length ? { newest: pairs[0].children[1], popular: pairs[0].children[0] } : null;
  }
  const tabActive = el => !!el && (/background-surface-primary/.test(el.className) ||
    el.getAttribute('aria-selected') === 'true' || el.dataset.state === 'active' ||
    /text-text-ui-primary/.test(String((el.querySelector('p') || el).className)));
  // 목록이 정말 최신순인지 (탭 색만 먼저 바뀌는 일이 있음)
  function looksNewestFirst() {
    const ts = [...commentRoot().querySelectorAll(ROW_SEL)].map(parseRow).filter(c => c && !c.isReply).slice(0, 10).map(c => c.minutesAgo);
    let bad = 0;
    for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1] - timeTolerance(ts[i - 1])) bad++;
    return bad <= 1;
  }
  // 결과: true(최신순) / false(못 바꿈) / 'none'(정렬 버튼 없음)
  async function sortByNewest() {
    const t = sortTabs();
    if (!t || !t.newest) return 'none';
    const sig = () => [...commentRoot().querySelectorAll(ROW_SEL)].slice(0, 3).map(r => visibleText(r).slice(0, 40)).join('|');
    for (let k = 0; k < 3; k++) {
      if (tabActive(t.newest) && !tabActive(t.popular) && looksNewestFirst()) return true;
      const before = sig();
      realClick(t.newest);
      await waitFor(() => tabActive(t.newest), 2500);
      await waitFor(() => sig() !== before || looksNewestFirst(), 8000, 200);
      await sleep(500);
      await waitCommentsReady(8000);
      if (tabActive(t.newest) && looksNewestFirst()) return true;
    }
    return false;
  }

  // 아래로 내려 다음 댓글을 불러옴. 최신순이면 기간 밖 댓글이 나오면 멈춤
  async function loadAllComments(newestFirst) {
    if (!await waitCommentsReady()) return;
    let stuck = 0, noBox = 0;
    for (let i = 0; i < T.scrollRounds && stuck < 4; i++) {
      const box = getScrollBox();
      if (!box) { if (++noBox > 3 || !await waitCommentsReady(5000)) break; i--; continue; }
      const before = rowCount();
      box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight * 3);
      await sleep(600);
      box.scrollTop = box.scrollHeight;
      const r = box.getBoundingClientRect();
      box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 400, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      await waitFor(() => rowCount() !== before, 3000);
      if (rowCount() === before) { if (document.hidden) { await waitVisible(); i--; continue; } stuck++; } else stuck = 0;
      if (!document.querySelector('img[alt="loading-icon"]')) break;
      const rows = document.querySelectorAll(ROW_SEL);
      const last = rows.length ? parseRow(rows[rows.length - 1]) : null;
      if (newestFirst && last && last.minutesAgo > S.maxAgeDays * 1440) break;
    }
    const box = getScrollBox();
    if (box) box.scrollTop = 0;
  }

  // 접힌 답글 펼치기 (원댓글이 오래돼도 답글은 최근일 수 있음). 이미 펼쳐진 글타래는 다시 누르면 접히므로 건너뜀
  async function expandReplies() {
    const rows = [...commentRoot().querySelectorAll(ROW_SEL)];
    for (const [i, row] of rows.entries()) {
      const c = parseRow(row);
      if (!c || c.isReply) continue;
      const next = rows[i + 1] && parseRow(rows[i + 1]);
      if (next && next.isReply) continue;
      // 답글 수 버튼 = 숫자만 있고 aria-expanded 가 붙은 버튼 (삭제된 원댓글은 답글 버튼 하나뿐)
      const nums = own(row, 'button').filter(b => /^\d+$/.test(visibleText(b)));
      const btn = nums.find(b => b.hasAttribute('aria-expanded')) || (c.removed ? nums[0] : nums[1]);
      if (!btn || visibleText(btn) === '0') continue;
      const before = rowCount();
      realClick(btn);
      await waitFor(() => rowCount() !== before, 2500);
      await sleep(150);
    }
    for (let k = 0; k < 60; k++) {
      const btn = [...commentRoot().querySelectorAll(`${ROW_SEL} button`)]
        .find(b => !b.dataset.fccTried && /^답글\s*(\d+\s*개\s*)?더\s*보기$/.test(visibleText(b)));
      if (!btn) break;
      btn.dataset.fccTried = '1';
      const before = rowCount();
      realClick(btn);
      await waitFor(() => rowCount() !== before, 3000);
      if (rowCount() > before) delete btn.dataset.fccTried;
    }
  }
  // 길어서 접힌 본문 펼치기
  async function expandBodies() {
    for (const b of [...commentRoot().querySelectorAll(`${ROW_SEL} button`)].filter(b => !b.dataset.fccMore && isText(b, '더보기'))) {
      b.dataset.fccMore = '1'; realClick(b); await sleep(120);
    }
  }

  // 댓글 창 열기 → 최신순 → 불러오기 → 답글·본문 펼치기
  async function collectComments() {
    const opened = await openComments();
    if (!opened) return { error: true };
    if (opened === 'empty') return { empty: true };
    const sorted = await sortByNewest();
    await loadAllComments(sorted !== false);
    await expandReplies();
    await expandBodies();
    return {};
  }

  const getDirectorId = () => {
    const a = [...document.querySelectorAll('a[href^="/users/profile/"]')].find(x => !x.closest(ROW_SEL) && !x.closest('#fccl'));
    return a ? a.getAttribute('href').split('?')[0].split('/').pop() : null;
  };

  // 화면의 댓글을 읽어 판정. 결과 hits = 지울 댓글
  function scan() {
    const directorId = getDirectorId();
    const rows = [...commentRoot().querySelectorAll(ROW_SEL)];
    const list = [], mineThreads = new Set();
    let unreadable = 0, topId = '';
    rows.forEach((row, i) => {
      const c = parseRow(row);
      if (!c) { unreadable++; return; }
      c.fccId = row.dataset.fccId = 's' + i;
      c.groupKey = c.userId || 'row:' + i;   // 탈퇴 계정은 서로 다른 사람일 수 있어 한 줄씩 따로
      if (!c.isReply) topId = c.fccId;
      c.top = c.isReply ? topId : c.fccId;
      const isMe = c.userId === directorId || c.isDirector;
      if (isMe) mineThreads.add(c.top);
      else if (c.isReply && mineThreads.has(c.top)) c.convo = true;   // 내가 먼저 답한 글타래의 답글 = 나와의 대화
      if (!c.kebab || c.removed || isDoneRow(row, c) || c.minutesAgo > S.maxAgeDays * 1440) return;
      if (isMe || c.liked || c.badge) return;   // 내 댓글 · 내가 ♥ 누른 댓글 · 파트너 디렉터는 안 건드림
      if (c.images.length || /[?？]/.test(c.body)) return;   // 사진·물음표 댓글은 안 건드림
      c.verdict = judgeText(c.body);
      list.push(c);
    });
    markBurst(list);
    // 나와 대화 중인 답글('ㅎㅎ' 등)은 금지어·구걸이 아니면 남김
    const light = ['온점·기호', '초성', '같은 말 반복', '도배'];
    list.forEach(c => { if (c.convo && light.includes(c.verdict)) c.verdict = null; });
    const hits = list.filter(c => c.verdict);
    return { hits, rows: rows.length, unreadable };
  }

  /* ===================== 삭제 ===================== */
  function realClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
      button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse', width: 1, height: 1, pressure: 0.5 };
    const down = { ...base, buttons: 1 }, up = { ...base, buttons: 0, pressure: 0 };
    [['pointerover', up], ['pointerenter', up], ['pointermove', up], ['pointerdown', down], ['mousedown', down],
      ['pointerup', up], ['mouseup', up], ['click', up]]
      .forEach(([t, o]) => el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)));
    return true;
  }
  // 주의: Esc 를 보내면 댓글 창까지 닫혀 메인 화면으로 튕김 → 메뉴는 바깥을 눌러 닫음
  function closeMenus() {
    if (![...document.querySelectorAll('[role="menu"]')].some(m => m.getAttribute('data-state') === 'open')) return;
    const root = commentRoot();
    const target = (root.querySelector ? root.querySelector(ROW_SEL) : null) || document.body;
    const r = target.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: r.x + 5, clientY: r.y + 5, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(t => target.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)));
  }

  // 같은 댓글인지 (사람·글·원댓글/답글·시간). 같은 사람이 같은 글을 여러 개 달았을 때 엉뚱한 것을 지우지 않게
  const sameAuthor = (a, b) => (a.userId || b.userId) ? a.userId === b.userId : a.name === b.name;
  const timeTolerance = min => min < 60 ? 10 : min < 1440 ? 60 : 1440;
  const sameKind = (c, t) => typeof t.isReply !== 'boolean' || c.isReply === t.isReply;
  const sameAs = (c, t) => c && c.kebab && !c.removed && sameAuthor(c, t) && norm(c.body) === norm(t.body) && sameKind(c, t) &&
    Math.abs(c.minutesAgo - t.minutesAgo) <= timeTolerance(t.minutesAgo);
  const countSame = t => [...document.querySelectorAll(ROW_SEL)].filter(r => sameAs(parseRow(r), t)).length;
  // '지운 줄' 표시: 사이트가 목록을 다시 그리면 같은 줄에 다른 댓글이 들어올 수 있어 내용까지 적어 둠
  const doneSig = c => `${c.userId || c.name}|${norm(c.body)}|${c.timeText}`;
  const isDoneRow = (r, c) => !!r.dataset.fccDone && !!c && r.dataset.fccDone === doneSig(c);
  function refind(target) {
    const byId = document.querySelector(`${ROW_SEL}[data-fcc-id="${target.fccId}"]`);
    if (byId) { const c = parseRow(byId); if (c && sameAuthor(c, target) && norm(c.body) === norm(target.body) && sameKind(c, target)) return c; }
    return [...document.querySelectorAll(ROW_SEL)].map(r => [r, parseRow(r)]).filter(([r, c]) => c && !isDoneRow(r, c)).map(([, c]) => c)
      .find(c => sameAs(c, target)) || null;
  }
  function isGone(rowEl, target) {
    if (!rowEl || !rowEl.isConnected) return true;
    const c = parseRow(rowEl);
    if (!c || c.removed || !c.kebab) return true;
    if (!sameAuthor(c, target) || norm(c.body) !== norm(target.body)) { delete rowEl.dataset.fccDone; return true; }
    return false;
  }
  // 줄이 사라졌고, 똑같아 보이는 댓글 수도 줄었을 때만 지워진 것
  function reallyGone(target) {
    if (!isGone(target.rowEl, target)) return false;
    if (typeof target.sameBefore !== 'number' || !document.querySelector(ROW_SEL)) return true;
    return countSame(target) < target.sameBefore;
  }

  // '삭제' 글자가 있는 메뉴 항목만 누름 (항목이 하나뿐이라고 누르면 안 됨 — '차단' 일 수 있음)
  function findMenuItem() {
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(m => m.offsetParent !== null && m.getAttribute('data-state') !== 'closed');
    if (!menus.length) return { err: '메뉴가 열리지 않음' };
    const items = [...menus[menus.length - 1].querySelectorAll('[role="menuitem"]')];
    const hit = items.find(i => i.innerText.trim() === '삭제') || items.find(i => i.innerText.includes('삭제'));
    return hit ? { el: hit } : { err: `삭제 항목이 없음 (${items.map(i => i.innerText.trim()).join('/')})` };
  }
  // 확인 창: 댓글 창도 dialog 라서, 댓글 줄이 없고 확인 버튼이 있는 창만
  const openDialog = () => [...document.querySelectorAll('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[data-slot="dialog-content"]')]
    .filter(d => d.querySelector('button[class*="frontia-action-button"]') && !d.querySelector(ROW_SEL)).pop() || null;
  function findConfirmButton() {
    const dlg = openDialog();
    if (!dlg) return { err: '확인 창이 뜨지 않음' };
    const hit = dlg.querySelector('button.frontia-action-button--error') ||
      [...dlg.querySelectorAll('button[class*="frontia-action-button"]:not(.frontia-action-button--ghost)')].find(b => b.innerText.includes('삭제')) ||
      [...dlg.querySelectorAll('button')].find(b => b.innerText.includes('삭제') && !b.innerText.includes('취소'));
    return hit ? { el: hit } : { err: '확인 버튼을 못 찾음' };
  }
  // 확인 버튼은 합성 클릭이 씹힐 때가 있어 시도마다 다른 방법 하나씩 (한꺼번에 하면 두 번 눌릴 수 있음)
  function pressHard(el, way) {
    if (way === 0) { realClick(el); return; }
    try { el.focus({ preventScroll: true }); } catch (e) { /* 무시 */ }
    if (way === 1) { el.click(); return; }
    ['keydown', 'keyup'].forEach(t => el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })));
  }
  function closeDialog() {
    const dlg = openDialog();
    const cancel = dlg && (dlg.querySelector('button.frontia-action-button--ghost') || [...dlg.querySelectorAll('button')].find(b => b.innerText.includes('취소')));
    if (cancel) pressHard(cancel, 0); else closeMenus();
  }
  const screenBusy = () => !!openDialog() || [...document.querySelectorAll('[role="menu"]')].some(m => m.getAttribute('data-state') === 'open') ||
    document.body.style.pointerEvents === 'none';
  // 앞 작업(메뉴·확인 창)이 끝날 때까지
  async function waitIdle(settle = true) {
    const until = Date.now() + T.idleWait, wasBusy = screenBusy();
    let nudged = false;
    while (screenBusy() && Date.now() < until) {
      if (!nudged && Date.now() > until - T.idleWait + 1500) { nudged = true; closeMenus(); if (openDialog()) closeDialog(); }
      await sleep(200);
    }
    if (!openDialog() && document.body.style.pointerEvents === 'none') document.body.style.removeProperty('pointer-events');
    if (settle || wasBusy) await sleep(400);
    return !screenBusy();
  }

  let manualMode = false;   // 자동 클릭이 안 먹는 환경이면 처음부터 사람에게 부탁
  async function deleteOne(target) {
    await waitVisible();
    if (!await waitIdle(false)) return { state: 'fail', msg: '앞 작업이 끝나지 않음' };
    const c = refind(target);
    if (!c) return { state: 'skip', msg: '화면에서 찾지 못함' };
    target.sameBefore = countSame(target);
    realClick(c.kebab);
    if (await waitFor(() => !findMenuItem().err, T.menuWait, 100)) await sleep(150);
    const mi = findMenuItem();
    if (mi.err) { closeMenus(); return { state: 'fail', msg: mi.err }; }
    realClick(mi.el);
    if (!await waitFor(openDialog, 2000)) {
      mi.el.focus();
      mi.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      await waitFor(openDialog, 2000);
    }
    let cb = findConfirmButton();
    if (cb.err) { closeDialog(); return { state: 'fail', msg: cb.err }; }
    let closed = false;
    for (let k = 0; k < (manualMode ? 1 : 3) && !closed; k++) {
      await waitVisible();
      pressHard(cb.el, k);
      closed = await waitFor(() => !openDialog(), 3000);
      if (closed) break;
      await sleep(700);
      const again = findConfirmButton();
      if (again.err) { closed = !openDialog(); break; }
      cb = again;
    }
    if (!closed) {
      // 자동으로 안 눌림 → 창을 그대로 두고 사람이 [삭제]를 누르길 3분까지 기다림
      status('화면의 [삭제] 직접 클릭 필요');
      if (!await waitFor(() => !openDialog(), 180000, 300)) {
        closeDialog(); await sleep(600); if (openDialog()) closeDialog();
        return { state: 'fail', blocked: true, msg: '삭제 확인이 되지 않음' };
      }
      manualMode = true;
    }
    c.el.dataset.fccDone = doneSig(c);
    target.rowEl = c.el;
    await waitIdle();
    await waitFor(() => reallyGone(target), T.reflectWait, 300);
    if (!reallyGone(target) && isGone(target.rowEl, target)) {
      await waitFor(() => reallyGone(target), T.finalCheckWait, 300);
      if (!reallyGone(target)) return { state: 'fail', msg: '지웠는데 같은 댓글이 그대로 있음' };
    }
    return reallyGone(target) ? { state: 'done' } : { state: 'pending' };
  }

  // 고른 댓글을 아래(오래된 것)부터 차례로. 결과: Map(댓글 → { state, msg })
  async function deleteBatch(picked, progress) {
    const order = [...document.querySelectorAll(ROW_SEL)];
    picked = [...picked].sort((a, b) => order.indexOf(b.el) - order.indexOf(a.el));
    const results = new Map(), pendings = [];
    let blockedRun = 0;
    for (const [n, c] of picked.entries()) {
      if (stopNow) break;
      progress(n + 1, picked.length);
      if (!commentPanel() && !await openComments()) break;   // 화면이 튕겼으면 다시 열어 보고, 안 되면 멈춤
      let r = await Promise.race([deleteOne(c), sleep(T.perItemMax).then(() => ({ state: 'fail', blocked: true, msg: '시간이 너무 오래 걸려 건너뜀' }))]);
      if (r.blocked) {
        // 사이트가 삭제를 안 받은 것 같으면 쉬었다가 한 번 더. 그때 화면에 없으면 첫 번째에 지워진 것
        closeDialog(); await sleep(T.blockedGap); await waitIdle();
        if (!commentPanel()) await openComments();
        r = await deleteOne(c);
        if (r.state === 'skip') r = { state: 'done' };
      }
      results.set(c, r);
      if (r.state === 'pending') pendings.push(c);
      blockedRun = r.blocked ? blockedRun + 1 : 0;
      if (blockedRun >= 2) break;   // 연달아 막히면 이 작품은 그만
      await sleep(T.deleteGap);
    }
    if (pendings.length) {
      await sleep(T.finalCheckWait);
      pendings.filter(reallyGone).forEach(c => results.set(c, { state: 'done' }));
    }
    return results;
  }

  /* ===================== 진행 (페이지를 옮겨 다니며) ===================== */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const PROFILE_RE = /^\/users\/profile\/[0-9a-f]{24}$/;
  // 이 탭의 표: 정리는 시작한 탭에서만 이어 감
  const TAB_ID = (() => {
    try { let t = sessionStorage.getItem('fccl.tab'); if (!t) { t = Math.random().toString(36).slice(2); sessionStorage.setItem('fccl.tab', t); } return t; } catch (e) { return 'tab'; }
  })();
  const STALE_MS = 3 * 60000;   // 이만큼 소식이 없으면 그 탭은 멈춘 것으로 봄
  const LIST_MAX = 500;

  let job = null, stopNow = false;
  function saveJob() {
    if (!job) return;
    const cur = readJSON(JOB_KEY, null);
    if (cur && cur.stop) { job.stop = true; stopNow = true; }   // 다른 탭에서 누른 '중단'
    job.beat = Date.now();
    writeJSON(JOB_KEY, job);
  }
  function go(url) { job.tries = (job.tries || 0) + 1; saveJob(); location.assign(url); }
  const here = () => location.pathname.replace(/\/+$/, '');
  const workUrl = w => `/episodes/${w.id}?panel=comments`;

  function startJob(mode) {
    job = { mode, step: 'home', owner: TAB_ID, i: 0, tries: 0, works: [], myId: '',
      out: { deleted: 0, found: [], unreadable: false } };
    stopNow = false; lastStatus = '시작 중…'; open = true;
    saveJob(); render(); runJob();
  }

  async function runJob() {
    try {
      if (job.stop || stopNow) return finish('멈춤');
      if (job.step === 'home') return await stepHome();
      if (job.step === 'profile') return await stepProfile();
      if (job.step === 'work') return await stepWork();
      return finish();
    } catch (e) {
      console.error('[댓글 관리]', e);
      const msg = (e && e.message) || String(e);
      if (job && job.step === 'work' && job.works[job.i]) return nextWork();   // 이 작품만 건너뜀
      return finish('오류로 멈춤: ' + msg);
    }
  }

  // 머리줄 오른쪽 끝의 둥근 프로필 그림 (못 찾으면 null)
  function avatar() {
    const search = document.querySelector('input');
    const sr = search && search.getBoundingClientRect();
    const inRow = r => sr ? (r.top + r.bottom) / 2 >= sr.top - 8 && (r.top + r.bottom) / 2 <= sr.bottom + 8 : r.bottom < 60;
    const right = [...document.querySelectorAll('img, button, a')].filter(e => {
      if (e.closest('#fccl')) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && inRow(r) && r.right <= innerWidth + 1;
    }).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    const img = right && (right.tagName === 'IMG' ? right : right.querySelector('img'));
    return img && !img.closest('a[href]') ? img : null;
  }

  // ① 첫 화면: 프로필 그림을 눌러 열린 메뉴에서 내 프로필 주소만 읽음 (메뉴 안은 누르지 않음 — 맨 아래가 로그아웃)
  async function stepHome() {
    if (here() !== '/home') return job.tries > 2 ? finish('프론티아 열기 실패') : go('/home');
    status('준비 중…');
    const img = await waitFor(avatar, 20000);
    if (!img) return finish('내 프로필 찾기 실패');
    await sleep(500);
    img.click();
    const href = await waitFor(() => { const a = document.querySelector('[role="dialog"] a[href^="/users/profile/"]'); return a && a.getAttribute('href').split('?')[0]; }, 10000);
    if (!href || !PROFILE_RE.test(href)) return finish('내 프로필 찾기 실패');
    job.myId = href.split('/').pop();
    job.step = 'profile'; job.tries = 0;
    return go(href + '?tab=episodes');
  }

  // ② 내 프로필: 작품 카드를 모음 (늦게 그려질 수 있어 수가 그대로일 때까지 내려 봄)
  async function stepProfile() {
    const path = '/users/profile/' + job.myId;
    if (here() !== path) return job.tries > 2 ? finish('내 프로필 찾기 실패') : go(path + '?tab=episodes');
    status('작품 찾는 중…');
    const cards = () => [...document.querySelectorAll('a[href*="/episodes/"]')].filter(a => !a.closest('#fccl'));
    await waitFor(() => cards().length, 20000);
    let last = -1, same = 0;
    for (let k = 0; k < 30 && same < 3; k++) {
      const n = cards().length;
      same = n === last ? same + 1 : 0; last = n;
      window.scrollBy(0, innerHeight);
      await sleep(700);
    }
    window.scrollTo(0, 0);
    const seen = new Set();
    const works = cards().map(a => {
      const id = new URL(a.href, location.origin).pathname.split('/')[2];
      if (!/^[0-9a-f]{24}$/.test(id || '') || seen.has(id)) return null;
      seen.add(id);
      return { id, title: (a.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '이름 없는 작품' };
    }).filter(Boolean);
    if (!works.length) return finish('작품 없음');
    S.works = works;   // 매번 프로필 순서로 새로 고침 (없어진 작품은 빠지고 새 작품은 체크된 채로)
    S.offWorks = S.offWorks.filter(id => works.some(w => w.id === id));
    saveSettings();
    if (job.mode === 'list') return finish();
    const on = works.filter(w => !S.offWorks.includes(w.id));
    if (!on.length) return finish('검사할 작품 없음');
    job.works = on; job.step = 'work'; job.i = 0; job.tries = 0;
    return go(workUrl(on[0]));
  }

  // ③ 작품 하나: 댓글 창 열기 → 판정 → 삭제 (먼저 보기면 모으기만)
  async function stepWork() {
    const w = job.works[job.i];
    if (!w) return finish();
    if (here() !== '/episodes/' + w.id) {
      if (job.tries > 2) return nextWork();
      return go(workUrl(w));
    }
    const label = `${w.title} (${job.i + 1}/${job.works.length})`;
    status(`${label} · 읽는 중…`);
    const r = await collectComments();
    if (stopNow) return finish('멈춤');
    if (r.error || r.empty || !mineHere()) return nextWork();   // 못 엶 · 댓글 없음 · 남의 작품
    await cleanHere(w, label);
    return nextWork();
  }

  // 이 화면이 내 작품인지: 댓글 밖 프로필 링크 중에 내 것이 있으면
  function mineHere() {
    if (!job.myId) return true;
    const ids = [...document.querySelectorAll('a[href^="/users/profile/"]')]
      .filter(a => !a.closest(ROW_SEL) && !a.closest('#fccl')).map(a => a.getAttribute('href').split('?')[0].split('/').pop());
    return !ids.length || ids.includes(job.myId);
  }

  function nextWork() {
    job.i++; job.tries = 0;
    if (job.stop || stopNow) return finish('멈춤');
    return job.i >= job.works.length ? finish() : go(workUrl(job.works[job.i]));
  }
  const progressFor = label => (n, tot) => status(`${label} · 지우는 중 ${n}/${tot}`);

  async function cleanHere(w, label) {
    const s = scan();
    if (s.rows && s.unreadable === s.rows) { job.out.unreadable = true; saveJob(); return; }
    if (job.mode === 'preview') { s.hits.forEach(c => job.out.found.push(c.body)); saveJob(); return; }
    if (!s.hits.length || stopNow) return;
    const res = await deleteBatch(s.hits, progressFor(label));
    for (const r of res.values()) if (r.state === 'done' || r.state === 'pending') job.out.deleted++;
    saveJob();
  }

  function finish(msg = '') {
    if (!job) return;
    if (job.mode === 'list') {
      // 작품 목록만 불러온 것: 결과는 그대로 두고 설정의 '검사 작품' 을 펼쳐 보여 줌
      writeJSON(JOB_KEY, null);
      job = null; stopNow = false;
      open = true; view = 'settings'; worksOpen = true; listMsg = msg;
      return render();
    }
    const o = job.out;
    writeJSON(LAST_KEY, { mode: job.mode, at: Date.now(), msg, deleted: o.deleted, found: o.found.slice(0, LIST_MAX),
      warn: o.unreadable ? '읽지 못한 작품 있음 · 프론티아 언어 한국어 필요' : '' });
    writeJSON(JOB_KEY, null);
    job = null; stopNow = false;
    open = true; view = 'main';
    render();
  }

  /* ===================== 화면 (오른쪽 아래 단추 + 창) ===================== */
  let open = false, view = 'main', lastStatus = '', worksOpen = false, listMsg = '';
  // 아이콘 (사용자 그림 64px)
  const ICON = 'data:image/png;base64,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';
  const icon = cls => `<img class="${cls}" src="${ICON}" alt="">`;
  const setLauncher = t => { launcher.innerHTML = icon('fl-ico') + esc(t); };
  let root = null, panel = null, launcher = null;
  const when = t => { const d = new Date(t); return `${d.getMonth() + 1}월 ${d.getDate()}일 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  // v2.0 의 결과(확인 목록)는 읽지 않음
  const lastResult = () => { const l = readJSON(LAST_KEY, null); return l && typeof l.deleted === 'number' ? l : null; };

  const CSS = `
#fccl, #fccl * { pointer-events: auto !important; box-sizing: border-box; }
#fccl { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; font: 14px/1.5 -apple-system, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; color: #eceef3; }
#fccl button { font: inherit; cursor: pointer; border: 0; border-radius: 10px; }
#fccl .fl-launch { float: right; display: flex; align-items: center; gap: 8px; background: #4b5563; color: #fff; padding: 8px 16px 8px 8px; font-weight: 700; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
#fccl .fl-ico { width: 30px; height: 30px; object-fit: contain; }
#fccl .fl-launch.run { background: #e17055; }
#fccl .fl-panel { clear: both; position: absolute; right: 0; bottom: 58px; width: min(360px, calc(100vw - 32px)); max-height: 72vh; overflow-y: auto;
  background: #1f2128; border: 1px solid #3a3d48; border-radius: 14px; padding: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.5); }
#fccl .fl-head { display: flex; align-items: center; gap: 8px; margin: -14px -14px 12px; padding: 10px 12px 10px 14px;
  background: #2e2a52; border-bottom: 1px solid #4b4580; border-radius: 13px 13px 0 0; position: sticky; top: -14px; z-index: 1; }
#fccl .fl-head .fl-ico { width: 26px; height: 26px; }
#fccl .fl-head b { font-size: 15px; flex: 1; }
#fccl .fl-icon { background: transparent; color: #a9b0c0; padding: 4px 8px; }
#fccl .fl-big { width: 100%; background: #6c5ce7; color: #fff; padding: 14px; font-size: 16px; font-weight: 700; }
#fccl .fl-red { width: 100%; background: #d63031; color: #fff; padding: 12px; font-weight: 700; }
#fccl .fl-link { background: transparent; color: #a9b0c0; text-decoration: underline; padding: 4px 0; font-size: 13px; }
#fccl .fl-hint { color: #9aa1b2; font-size: 12.5px; margin: 6px 0; text-align: center; }
#fccl .fl-done { font-size: 15px; font-weight: 700; margin: 2px 0 10px; }
#fccl .fl-meta { color: #8d94a5; font-size: 12px; font-weight: 400; }
#fccl .fl-warn { background: #3d2f1c; color: #ffd59a; border-radius: 10px; padding: 8px 10px; margin: 8px 0; font-size: 13px; }
#fccl .fl-status { font-weight: 600; margin: 6px 0 10px; word-break: break-all; }
#fccl .fl-item { background: #272a33; border-radius: 8px; padding: 6px 10px; margin: 4px 0; white-space: pre-wrap; word-break: break-word; max-height: 6em; overflow-y: auto; }
#fccl .fl-bar { position: sticky; bottom: -14px; background: #1f2128; padding: 10px 0 2px; }
#fccl label.fl-row { display: block; margin: 10px 0; }
#fccl input[type=number] { width: 56px; background: #2d303a; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 4px 6px; font: inherit; }
#fccl textarea { width: 100%; height: 60px; background: #2d303a; color: #fff; border: 1px solid #444; border-radius: 8px; padding: 8px; font: inherit; margin-top: 4px; }
#fccl details { margin: 10px 0; }
#fccl summary { cursor: pointer; list-style: none; font-weight: 600; }
#fccl summary::-webkit-details-marker { display: none; }
#fccl .fl-arrow { font-size: 11px; color: #a9b0c0; display: inline-block; transition: transform .15s; }
#fccl details[open] .fl-arrow { transform: rotate(180deg); }
#fccl .fl-note { color: #9aa1b2; font-size: 12.5px; margin: 4px 0 12px; }
#fccl .fl-works { max-height: 40vh; overflow-y: auto; margin: 6px 0; }
#fccl label.fl-work { display: block; margin: 4px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#fccl input[type=checkbox] { width: 18px; height: 18px; vertical-align: -3px; accent-color: #6c5ce7; }
`;

  function buildUi() {
    if (!document.getElementById('fccl-css')) {
      const st = document.createElement('style');
      st.id = 'fccl-css'; st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    root = document.createElement('div');
    root.id = 'fccl';
    root.innerHTML = '<button class="fl-launch" type="button"></button><div class="fl-panel" hidden></div>';
    document.body.appendChild(root);
    launcher = root.querySelector('.fl-launch');
    panel = root.querySelector('.fl-panel');
    launcher.addEventListener('click', () => { open = !open; view = 'main'; render(); });
    panel.addEventListener('click', onClick);
  }

  const runLabel = () => job.mode === 'list' ? '작품 찾는 중' : `정리 중 ${Math.min(job.i + 1, job.works.length || 1)}/${job.works.length || '…'}`;
  function status(t) {
    lastStatus = t;
    const el = panel && panel.querySelector('.fl-status');
    if (el) el.textContent = t;
    if (job && launcher) setLauncher(runLabel());
  }
  // 다른 탭에서 진행 중인 정리 (3분 넘게 소식이 없으면 멈춘 것으로 보고 무시)
  function otherJob() {
    const cur = readJSON(JOB_KEY, null);
    return cur && cur.owner !== TAB_ID && Date.now() - (cur.beat || 0) < STALE_MS ? cur : null;
  }

  function render() {
    if (!root || !root.isConnected) buildUi();
    setLauncher(job ? runLabel() : '댓글 관리');
    launcher.classList.toggle('run', !!job);
    panel.hidden = !open;
    if (!open) return;
    const settings = view === 'settings' && !job;
    panel.innerHTML = `<div class="fl-head">${settings ? '<button class="fl-icon" data-act="back">←</button>' : icon('fl-ico')}<b>${settings ? '설정' : '댓글 관리'}</b>` +
      `${!job && !settings ? '<button class="fl-icon" data-act="settings" title="설정">⚙</button>' : ''}<button class="fl-icon" data-act="close">✕</button></div>` +
      (job ? runHtml() : settings ? settingsHtml() : mainHtml());
    if (settings) fillSettings();
  }

  const runHtml = () => `<div class="fl-status">${esc(lastStatus)}</div>
    <button class="fl-red" data-act="stop">중단</button><div class="fl-hint">이 탭 유지</div>`;

  function mainHtml() {
    if (otherJob()) return `<div class="fl-warn">다른 탭에서 정리 중</div><button class="fl-red" data-act="stopOther">중단</button>`;
    const last = lastResult();
    const start = `<button class="fl-big" data-act="start">정리 시작</button>` +
      `<div class="fl-hint">${worksLabel()} · 최근 ${S.maxAgeDays}일${S.previewFirst ? ' · 먼저 보기' : ''}</div>`;
    if (!last) return start;
    const found = last.mode === 'preview' ? last.found || [] : [];
    const head = `<div class="fl-done">${last.mode === 'preview' ? `감지 ${found.length}건` : `✔ ${last.deleted}건 삭제`}` +
      ` <span class="fl-meta">· ${esc(when(last.at))}</span></div>` +
      (last.msg ? `<div class="fl-warn">${esc(last.msg)}</div>` : '') + (last.warn ? `<div class="fl-warn">${esc(last.warn)}</div>` : '');
    if (!found.length || !S.previewFirst) return head + start;   // 먼저 보기를 끈 뒤에는 바로 [정리 시작]
    return head + found.map(b => `<div class="fl-item">${esc(b)}</div>`).join('') +
      `<div class="fl-bar"><button class="fl-red" data-act="delAll">${found.length}건 지우기</button><div class="fl-hint"><button class="fl-link" data-act="start">다시 보기</button></div></div>`;
  }

  const onCount = () => S.works.filter(w => !S.offWorks.includes(w.id)).length;
  const worksLabel = () => S.works.length ? `작품 ${onCount()}/${S.works.length}` : '작품 목록 없음';
  const worksHtml = () => `<details id="fl-works-box"${worksOpen ? ' open' : ''}><summary>검사 작품 (${S.works.length ? `${onCount()}/${S.works.length}` : '없음'}) <span class="fl-arrow">▼</span></summary>
    ${listMsg ? `<div class="fl-warn">${esc(listMsg)}</div>` : ''}
    <div class="fl-works">${S.works.map(w => `<label class="fl-work"><input type="checkbox" data-wid="${esc(w.id)}"${S.offWorks.includes(w.id) ? '' : ' checked'}> ${esc(w.title)}</label>`).join('')}</div>
    <button class="fl-link" data-act="loadWorks">${S.works.length ? '목록 다시 불러오기' : '목록 불러오기'}</button></details>`;
  const settingsHtml = () => `${worksHtml()}<label class="fl-row">검사 기간: <input type="number" id="fl-days" min="1" max="60"> 일</label>
    <label class="fl-row">금지어<textarea id="fl-words" placeholder="맞팔, 임무, 출석"></textarea></label>
    <label class="fl-row">지우기 전 확인 <input type="checkbox" id="fl-preview"></label>
    <div class="fl-note">*기본 삭제: 온점(.), 초성도배, 이모지 하나</div>
    <button class="fl-big" data-act="saveSettings">저장</button>
    <div class="fl-hint">v${VERSION}</div>`;
  function fillSettings() {
    panel.querySelector('#fl-days').value = S.maxAgeDays;
    panel.querySelector('#fl-words').value = (S.offTopicWords || []).join(', ');
    panel.querySelector('#fl-preview').checked = !!S.previewFirst;
  }
  function readSettings() {
    const d = parseInt(panel.querySelector('#fl-days').value, 10);
    S.maxAgeDays = Number.isFinite(d) ? Math.min(60, Math.max(1, d)) : DEFAULTS.maxAgeDays;
    S.offTopicWords = [...new Set(panel.querySelector('#fl-words').value.split(/[,，\n]/).map(w => w.trim()).filter(Boolean))];
    S.previewFirst = panel.querySelector('#fl-preview').checked;
    S.offWorks = [...panel.querySelectorAll('input[data-wid]')].filter(i => !i.checked).map(i => i.dataset.wid);
    saveSettings();
  }

  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') { open = false; render(); return; }
    if (act === 'settings') { view = 'settings'; worksOpen = false; listMsg = ''; render(); return; }
    if (act === 'back') { view = 'main'; render(); return; }
    if (act === 'saveSettings') { readSettings(); view = 'main'; render(); return; }
    if (act === 'loadWorks') { readSettings(); startJob('list'); return; }
    if (act === 'start') {
      if (!S.works.length) { startJob('list'); return; }   // 처음: 작품 목록부터 불러와 고르게 함
      if (!S.previewFirst && gmGet(AGREED_KEY, '') !== '1') {
        if (!confirm('금지어·어뷰징 댓글 바로 삭제\n(되돌리기 불가)')) return;
        gmSet(AGREED_KEY, '1');
      }
      startJob(S.previewFirst ? 'preview' : 'clean');
      return;
    }
    if (act === 'delAll') {
      // 먼저 본 목록 그대로가 아니라, 다시 읽어 그때 걸린 것을 지움
      const n = ((lastResult() || {}).found || []).length;
      if (!confirm(`${n}건 삭제\n(되돌리기 불가)`)) return;
      gmSet(AGREED_KEY, '1');
      startJob('clean');
      return;
    }
    if (act === 'stop') { stopNow = true; if (job) { job.stop = true; saveJob(); } status('멈추는 중…'); return; }
    if (act === 'stopOther') { const cur = readJSON(JOB_KEY, null); if (cur) { cur.stop = true; writeJSON(JOB_KEY, cur); } render(); }
  }

  /* ---------- 시작 ---------- */
  setInterval(() => { if (job) saveJob(); }, 20000);   // 진행 중 표시 + 다른 탭에서 누른 '중단' 받기
  setInterval(() => { if (document.body && (!root || !root.isConnected)) render(); }, 2000);   // 사이트가 화면을 다시 그려 단추가 사라지면

  function boot() {
    const cur = readJSON(JOB_KEY, null);
    if (cur && cur.owner === TAB_ID) {
      job = cur; open = true; lastStatus = '이어서 진행 중…';
      render();
      setTimeout(runJob, 800);
    } else render();
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();

import { firebaseConfig } from './firebase-config.js';
import { HOLIDAYS } from './holidays.js';

const DEMO = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('YOUR');
const FIREBASE_VERSION = '10.12.2';
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
// 초록(모두 되는 날)과 빨강(X 표시)은 의미가 있는 색이라 이름표 색에서 뺐어요
const STICKER_COLORS = ['#1cb0f6', '#ce82ff', '#ff9600', '#ffc800', '#ff86d0', '#2b70c9', '#a56644', '#777777'];
const CAP_MIN = 2;
const CAP_MAX = 30;
const CAP_DEFAULT = 4;
const app = document.getElementById('app');

const state = {
  roomId: null,
  room: null,          // { title, months: ['2026-12', ...], capacity: 4 }
  members: [],         // [{ id, name, dates: [], done }]
  me: null,
  wasMember: false,
  isHost: false,
  mi: 0,               // 보고 있는 달 (months의 인덱스)
  selected: null,
  justMarked: null,    // 방금 X 친 날짜들 (그리는 애니메이션용)
  sheet: null,         // 아래에서 올라온 날짜 상세 (결과 보기 모드)
  erasing: new Map(),  // 지우개로 지우는 중인 날짜 → 시작 시각
  drag: null,
  deferRender: false,
  editingMonths: false,
  editDraft: null,
  editCap: null,
  screen: null,
  focusKey: null,
};

let store;

// 화면 바꾸기 (null인 조각은 건너뛰어요)
function show(...parts) { app.replaceChildren(...parts.flat().filter((p) => p != null && p !== false)); }

/* ================= 유틸 ================= */

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const ymKey = (y, m) => `${y}-${pad(m + 1)}`;
const parseYM = (ym) => { const [y, m] = ym.split('-').map(Number); return [y, m - 1]; };
function todayStr() { const t = new Date(); return ymd(t.getFullYear(), t.getMonth(), t.getDate()); }
function currentYM() { const t = new Date(); return ymKey(t.getFullYear(), t.getMonth()); }
function dateLabel(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return `${m}월 ${d}일 (${WEEK[new Date(y, m - 1, d).getDay()]})`;
}
function weekday(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d).getDay(); }
function hash(s) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
const colorOf = (name) => STICKER_COLORS[hash(name) % STICKER_COLORS.length];
const tiltOf = (name) => `${((hash(name) % 5) - 2) * 0.7}deg`;
const normalizeName = (raw) => raw.replace(/\s+/g, ' ').trim().slice(0, 20);
const memberKey = (name) => encodeURIComponent(name.replace(/\s+/g, '').toLowerCase());

function nextMonths(count) {
  const t = new Date();
  return Array.from({ length: count }, (_, i) => { const d = new Date(t.getFullYear(), t.getMonth() + i, 1); return ymKey(d.getFullYear(), d.getMonth()); });
}
function monthName(ym, withYear = false) {
  const [y, m] = parseYM(ym);
  return withYear ? `${y}년 ${m + 1}월` : `${m + 1}월`;
}
function monthsPhrase(months) {
  const names = months.map((ym) => monthName(ym));
  if (names.length === 1) return `${names[0]} 중에 모여요`;
  const contiguous = months.every((ym, i) => {
    if (i === 0) return true;
    const [y, m] = parseYM(months[i - 1]);
    const n = new Date(y, m + 1, 1);
    return ym === ymKey(n.getFullYear(), n.getMonth());
  });
  if (names.length === 2) return `${names[0]}이나 ${names[1]} 중에 모여요`;
  if (contiguous) return `${names[0]}부터 ${names[names.length - 1]} 사이에 모여요`;
  return `${names.join(', ')} 중에 모여요`;
}

function newId() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } }

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2800);
}

// 다시 그린 뒤에도 키보드 포커스가 유지되도록
document.addEventListener('click', (e) => {
  const k = e.target.closest('[data-k]');
  state.focusKey = k ? k.dataset.k : null;
}, true);
function restoreFocus() {
  if (!state.focusKey) return;
  const t = app.querySelector(`[data-k="${CSS.escape(state.focusKey)}"]`);
  if (t && !t.disabled) t.focus({ preventScroll: true });
}

/* ================= 저장소 ================= */

async function firebaseStore() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const f = await import(`${base}/firebase-firestore.js`);
  const db = f.getFirestore(initializeApp(firebaseConfig));
  const roomRef = (id) => f.doc(db, 'rooms', id);
  return {
    async createRoom(title, months, capacity) {
      const id = newId();
      await f.setDoc(roomRef(id), { title, months, capacity, createdAt: f.serverTimestamp() });
      return id;
    },
    watchRoom(id, cb, onErr) {
      return f.onSnapshot(roomRef(id), (s) => cb(s.exists() ? s.data() : null), onErr);
    },
    async updateRoom(id, patch) { await f.updateDoc(roomRef(id), patch); },
    watchMembers(id, cb, onErr) {
      return f.onSnapshot(f.collection(db, 'rooms', id, 'members'),
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onErr);
    },
    async saveMember(id, { name, dates, done }) {
      await f.setDoc(f.doc(db, 'rooms', id, 'members', memberKey(name)),
        { name, dates, done: !!done, updatedAt: f.serverTimestamp() });
    },
    async deleteMember(id, key) { await f.deleteDoc(f.doc(db, 'rooms', id, 'members', key)); },
  };
}

// Firebase 설정 전 화면 확인용. 같은 브라우저의 다른 탭끼리는 실시간으로 동기화돼요.
function demoStore() {
  const KEY = 'unzeboka-demo-v1';
  const listeners = new Set();
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const write = (d) => { lsSet(KEY, JSON.stringify(d)); listeners.forEach((f) => f()); };
  window.addEventListener('storage', (e) => { if (e.key === KEY) listeners.forEach((f) => f()); });
  const listen = (f) => { listeners.add(f); queueMicrotask(f); return () => listeners.delete(f); };
  return {
    async createRoom(title, months, capacity) { const d = read(); const id = newId(); d[id] = { title, months, capacity, members: {} }; write(d); return id; },
    watchRoom(id, cb) { return listen(() => { const r = read()[id]; cb(r ? { title: r.title, months: r.months, capacity: r.capacity } : null); }); },
    async updateRoom(id, patch) { const d = read(); if (d[id]) { Object.assign(d[id], patch); write(d); } },
    watchMembers(id, cb) {
      return listen(() => { const r = read()[id]; cb(r ? Object.entries(r.members).map(([k, v]) => ({ id: k, ...v })) : []); });
    },
    async saveMember(id, { name, dates, done }) {
      const d = read(); if (!d[id]) return;
      d[id].members[memberKey(name)] = { name, dates, done: !!done }; write(d);
    },
    async deleteMember(id, key) { const d = read(); if (d[id]) { delete d[id].members[key]; write(d); } },
  };
}

/* ================= 시작 ================= */

init();

async function init() {
  try {
    store = DEMO ? demoStore() : await firebaseStore();
  } catch (e) {
    console.error(e);
    return renderError('Firebase에 연결하지 못했어요. firebase-config.js 설정과 인터넷 연결을 확인해 주세요.');
  }

  const id = new URLSearchParams(location.search).get('room');
  if (!id) return renderHome();

  show(el('p', { class: 'muted', text: '모임을 불러오는 중…' }));
  state.roomId = id;
  state.me = lsGet('name:' + id);
  state.isHost = lsGet('host:' + id) === '1';
  const onErr = (e) => { console.error(e); toast('실시간 연결이 끊겼어요. 새로고침해 주세요.'); };

  let started = false;
  store.watchRoom(id, (room) => {
    if (!room) return renderError(started ? '이 모임은 더 이상 없어요.' : '없는 모임이에요. 받은 링크가 맞는지 확인해 주세요.');
    const firstLoad = !state.room;
    state.room = room;
    if (firstLoad) state.mi = initialMonthIndex();
    if (!started) {
      started = true;
      store.watchMembers(id, onMembers, onErr);
    } else {
      render();
    }
  }, (e) => { onErr(e); renderError('모임을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.'); });
}

function onMembers(list) {
  state.members = list
    .map((m) => ({ ...m, dates: Array.isArray(m.dates) ? m.dates : [], done: !!m.done }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  if (state.me) {
    if (myMember()) state.wasMember = true;
    else if (state.wasMember) {
      // 방장이 나를 뺐거나 다른 기기에서 나간 경우
      forgetMe();
      toast('모임에서 빠졌어요. 다시 참여할 수 있어요.');
    }
  }
  render();
}

function getMonths() {
  const ms = Array.isArray(state.room?.months) ? [...new Set(state.room.months)].sort() : [];
  return ms.length ? ms : [currentYM()];
}
// 방장이 정한 정원. 예전에 만든 모임은 정원이 없어서 null이에요.
function getCapacity() {
  const c = Number(state.room?.capacity);
  return Number.isInteger(c) && c > 0 ? c : null;
}
// 정원만큼 들어와서 모두 '다 표시했어요'를 눌렀는지
function everyoneDone() {
  const total = state.members.length;
  const cap = getCapacity();
  if (!total || (cap && total < cap)) return false;
  return state.members.every((p) => p.done);
}

function initialMonthIndex() {
  const ms = getMonths();
  const i = ms.findIndex((ym) => ym >= currentYM());
  return i === -1 ? ms.length - 1 : i;
}

function render() {
  if (state.drag) { state.deferRender = true; return; }
  if (!state.room) return;
  if (!state.me) {
    if (state.screen === 'join') fillJoinList();
    else renderJoin();
  } else {
    renderRoom();
  }
  renderSheet();
}

/* ================= 화면: 홈 ================= */

function demoNotice() {
  return DEMO
    ? el('p', { class: 'notice', text: '지금은 체험 모드예요. 기록이 이 브라우저에만 저장돼요. firebase-config.js를 채우면 친구들과 공유돼요.' })
    : null;
}

function stickers() {
  const wrap = document.createElement('div');
  wrap.setAttribute('aria-hidden', 'true');
  // 눈 달린 달력 캐릭터 (X 친 날 하나, 체크한 날 하나)
  wrap.innerHTML =
    `<svg class="sticker cal-buddy" viewBox="0 0 96 96">` +
      `<rect x="10" y="18" width="76" height="70" rx="16" fill="#fff" stroke="#e5e5e5" stroke-width="4"/>` +
      `<path d="M10 34a16 16 0 0 1 16-16h44a16 16 0 0 1 16 16v4H10z" fill="#58cc02"/>` +
      `<rect x="28" y="8" width="8" height="18" rx="4" fill="#58a700"/><rect x="60" y="8" width="8" height="18" rx="4" fill="#58a700"/>` +
      `<circle cx="36" cy="56" r="6" fill="#4b4b4b"/><circle cx="60" cy="56" r="6" fill="#4b4b4b"/>` +
      `<circle cx="38" cy="54" r="2" fill="#fff"/><circle cx="62" cy="54" r="2" fill="#fff"/>` +
      `<path d="M40 70q8 7 16 0" stroke="#4b4b4b" stroke-width="4" fill="none" stroke-linecap="round"/>` +
    `</svg>` +
    `<svg class="sticker badge-x" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#ff4b4b"/><path d="M13 13l14 14M27 13L13 27" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>` +
    `<svg class="sticker badge-ok" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#58cc02"/><path d="M12 21l6 6 11-13" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return [...wrap.children];
}

function monthChips(options, selected, onToggle) {
  const thisYear = new Date().getFullYear();
  return el('div', { class: 'months', role: 'group', 'aria-label': '모일 달' },
    options.map((ym) => {
      const [y] = parseYM(ym);
      return el('button', {
        type: 'button',
        'data-k': 'm-' + ym,
        'aria-pressed': String(selected.has(ym)),
        text: y === thisYear ? monthName(ym) : monthName(ym, true),
        onclick: (e) => { onToggle(ym); e.currentTarget.setAttribute('aria-pressed', String(selected.has(ym))); },
      });
    }));
}

function capacityStepper(get, set) {
  const out = el('output', { class: 'num', 'aria-live': 'polite' });
  const minus = el('button', { type: 'button', class: 'step', 'aria-label': '한 명 줄이기', text: '−', onclick: () => change(-1) });
  const plus = el('button', { type: 'button', class: 'step', 'aria-label': '한 명 늘리기', text: '+', onclick: () => change(1) });
  function sync() {
    out.textContent = `${get()}명`;
    minus.disabled = get() <= CAP_MIN;
    plus.disabled = get() >= CAP_MAX;
  }
  function change(d) { set(Math.min(CAP_MAX, Math.max(CAP_MIN, get() + d))); sync(); }
  sync();
  return el('div', { class: 'stepper', role: 'group', 'aria-label': '모일 인원' }, minus, out, plus);
}

function renderHome() {
  state.screen = 'home';
  const picked = new Set([currentYM()]);
  let capacity = CAP_DEFAULT;
  const input = el('input', { type: 'text', maxlength: '40', placeholder: '예: 연말 송년회', id: 'title' });
  const btn = el('button', { class: 'pill big wide', type: 'submit', text: '모임 만들기' });

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const title = input.value.replace(/\s+/g, ' ').trim();
      if (!title) { toast('모임 이름을 적어 주세요.'); return input.focus(); }
      if (!picked.size) return toast('모일 달을 하나 이상 골라 주세요.');
      btn.disabled = true;
      try {
        const id = await store.createRoom(title, [...picked].sort(), capacity);
        lsSet('host:' + id, '1');
        location.href = `?room=${id}`;
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        toast('모임을 만들지 못했어요. 다시 시도해 주세요.');
      }
    },
  },
    el('label', { class: 'field', for: 'title' }, el('span', { text: '모임 이름' }), input),
    el('div', { class: 'field' }, el('span', { text: '몇 명이 모여요?' }),
      capacityStepper(() => capacity, (v) => { capacity = v; }),
      el('p', { class: 'muted small', text: '나를 포함한 인원이에요. 이만큼 다 표시해야 모두 되는 날이 보여요.' })),
    el('div', { class: 'field' }, el('span', { text: '언제쯤 모일까요?' }),
      monthChips(nextMonths(6), picked, (ym) => (picked.has(ym) ? picked.delete(ym) : picked.add(ym))),
      el('p', { class: 'muted small', text: '여러 달을 골라도 돼요. 고른 달 안에서 가장 좋은 날을 찾아줘요.' })),
    btn,
  );

  show(
    el('section', { class: 'hero' },
      stickers(),
      el('h1', { text: '언제보까' }),
      el('span', { class: 'caption', text: '안 되는 날에 X만 쳐!' }),
      el('p', { class: 'lede', text: '친구들한테 링크 하나 보내면, 다 같이 되는 날이 저절로 보여요.' }),
    ),
    demoNotice(),
    form,
  );
}

/* ================= 화면: 이름 입력 ================= */

let joinListBox;

function renderJoin() {
  state.screen = 'join';
  const input = el('input', { type: 'text', maxlength: '20', placeholder: '이름 또는 별명', id: 'name', autocomplete: 'nickname' });
  const form = el('form', { onsubmit: (e) => { e.preventDefault(); join(input.value); } },
    el('label', { class: 'field', for: 'name' }, el('span', { text: '이름이 뭐예요?' }), input),
    el('button', { class: 'pill big wide', type: 'submit', text: '참여하기' }));

  joinListBox = el('div');
  show(
    el('section', { class: 'room-head' },
      el('h1', { text: state.room.title }),
      roomCaption()),
    el('p', { class: 'muted', style: 'margin-bottom:22px', text: '이름을 알려주면 누가 어느 날 안 되는지 다 같이 볼 수 있어요.' }),
    demoNotice(),
    form,
    joinListBox,
  );
  fillJoinList();
}

function fillJoinList() {
  if (!joinListBox) return;
  if (!state.members.length) { joinListBox.replaceChildren(); return; }
  joinListBox.replaceChildren(
    el('p', { class: 'muted small', style: 'margin:30px 0 10px', text: '이미 참여했다면 내 이름표를 눌러 주세요.' }),
    el('div', { class: 'labels' }, state.members.map((m) =>
      el('button', { class: 'label', type: 'button', style: `--c:${colorOf(m.name)};--tilt:${tiltOf(m.name)};cursor:pointer`, onclick: () => join(m.name) },
        el('span', { class: 'dot' }), m.name))),
  );
}

function join(raw) {
  let name = normalizeName(raw);
  if (!name) { toast('이름을 적어 주세요.'); return; }
  const existing = state.members.find((m) => m.id === memberKey(name));
  if (existing) {
    name = existing.name;
    toast(`${name} 이름으로 이어서 표시해요.`);
  } else {
    const me = { id: memberKey(name), name, dates: [], done: false };
    state.members.push(me);
    save(me);
  }
  state.me = name;
  state.wasMember = false;
  lsSet('name:' + state.roomId, name);
  state.screen = 'room';
  render();
}

function forgetMe() {
  lsDel('name:' + state.roomId);
  state.me = null;
  state.wasMember = false;
  state.screen = null;
  state.selected = null;
}

/* ================= 화면: 모임 ================= */

function roomCaption() {
  const cap = getCapacity();
  return el('div', { class: 'caption' },
    el('span', { text: monthsPhrase(getMonths()) }),
    cap ? el('span', { class: 'chip', text: `${cap}명 모임` }) : null);
}

function myMember() { return state.me ? state.members.find((m) => m.id === memberKey(state.me)) : null; }
function ensureMe() {
  let me = myMember();
  if (!me) { me = { id: memberKey(state.me), name: state.me, dates: [], done: false }; state.members.push(me); }
  return me;
}
// 다른 사람 표시에 휩쓸리지 않도록, 내가 다 표시하기 전에는 남의 결과를 가려요
function revealed() { return !!myMember()?.done; }
function myDateSet() { const me = myMember(); return new Set(me ? me.dates : []); }
function unavailableOn(ds) { return state.members.filter((m) => m.dates.includes(ds)); }

function save(me) {
  store.saveMember(state.roomId, { name: me.name, dates: me.dates, done: me.done }).catch((e) => {
    console.error(e);
    toast('저장하지 못했어요. 다시 시도해 주세요.');
  });
}

function setDates(dates, mark, animate = true) {
  const me = ensureMe();
  const set = new Set(me.dates);
  if (!mark && animate) dates.forEach((d) => { if (set.has(d)) startErase(d); });
  dates.forEach((d) => { if (mark) { set.add(d); state.erasing.delete(d); } else set.delete(d); });
  me.dates = [...set].sort();
  state.justMarked = mark && animate ? new Set(dates) : null;
  render();
  save(me);
}

function toggleDone() {
  const me = ensureMe();
  me.done = !me.done;
  render();
  save(me);
  if (me.done) toast('고마워요! 이제 모두의 결과가 보여요.');
}

/* 지우개로 쓱싹 */
const ERASE_MS = 560;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function startErase(ds) {
  if (reducedMotion()) return;
  state.erasing.set(ds, performance.now());
  setTimeout(() => {
    const t = state.erasing.get(ds);
    if (t != null && performance.now() - t >= ERASE_MS - 20) state.erasing.delete(ds);
  }, ERASE_MS);
}
// 다시 그려도 애니메이션이 처음부터 시작하지 않도록, 지난 시간만큼 앞당겨서 이어 그려요
function eraseMark(ds) {
  const elapsed = performance.now() - state.erasing.get(ds);
  if (!(elapsed < ERASE_MS)) return null;
  const w = xMark(ds, false);
  w.classList.add('erase');
  w.style.setProperty('--t', `${-Math.round(elapsed)}ms`);
  w.insertAdjacentHTML('beforeend',
    '<span class="crumbs"><i></i><i></i><i></i><i></i></span>' +
    '<svg class="eraser" viewBox="0 0 46 28" aria-hidden="true">' +
      '<rect x="2" y="2" width="42" height="24" rx="5" fill="#fafafa" stroke="#bdbdbd" stroke-width="2"/>' +
      '<rect x="15" y="2" width="29" height="24" rx="2" fill="#2f5fb3" stroke="#244a8c" stroke-width="2"/>' +
      '<rect x="15" y="15" width="29" height="4" fill="#fff"/>' +
      '<rect x="15" y="19" width="29" height="3" fill="#222"/>' +
    '</svg>');
  w.addEventListener('animationend', (e) => { if (e.target === w) w.remove(); });
  return w;
}

function xMark(ds, draw) {
  const w = document.createElement('span');
  w.className = 'x' + (draw ? ' draw' : '');
  const h = hash(ds);
  const r = (h % 13) - 6;            // 손으로 그은 듯 살짝씩 다른 각도
  const j = (h >> 4) % 3;            // 획마다 살짝 다른 휘어짐
  w.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true" style="transform:rotate(${r}deg)">` +
    `<path d="M8 8 Q${19 + j} ${21 - j} 32 32"/><path d="M32 7 Q${21 - j} ${19 + j} 8 33"/></svg>`;
  return w;
}

function renderRoom() {
  state.screen = 'room';
  const months = getMonths();
  state.mi = Math.min(Math.max(state.mi, 0), months.length - 1);
  const [y, m] = parseYM(months[state.mi]);
  const today = todayStr();
  const myKey = memberKey(state.me);
  const me = myMember();
  const myDates = new Set(me ? me.dates : []);
  const total = state.members.length;
  const doneCount = state.members.filter((p) => p.done).length;
  const cap = getCapacity();
  const missing = cap ? Math.max(0, cap - total) : 0;   // 아직 안 들어온 사람 수
  const allDone = everyoneDone();

  /* 헤더 */
  const head = el('section', { class: 'room-head' },
    el('h1', { text: state.room.title }),
    roomCaption(),
    state.editingMonths ? monthEditor(months) : null,
    el('div', { class: 'meta' },
      el('div', { class: 'who' },
        el('span', {}, '나: ', el('strong', { text: state.me })),
        el('button', { class: 'textbtn', type: 'button', text: '이름 바꾸기', onclick: () => { forgetMe(); render(); } }),
        state.isHost && !state.editingMonths
          ? el('button', { class: 'textbtn', type: 'button', 'data-k': 'edit-months', text: '기간·인원 바꾸기', onclick: () => { state.editingMonths = true; state.editDraft = new Set(months); state.editCap = cap || Math.max(CAP_MIN, Math.min(CAP_MAX, total)); render(); } })
          : null,
      ),
      el('button', { class: 'pill small blue', type: 'button', text: '초대 링크 보내기', onclick: shareLink }),
    ),
  );

  /* 이름표 */
  const labels = el('div', { style: 'margin-top:18px' },
    el('ul', { class: 'labels', 'aria-label': `참여한 사람 ${total}명` },
      state.members.map((p) => el('li', {
        class: 'label' + (p.id === myKey ? ' me' : ''),
        style: `--c:${colorOf(p.name)};--tilt:${tiltOf(p.name)}`,
      },
        el('span', { class: 'dot' }),
        p.name,
        el('span', { class: 'st' + (p.done ? ' done' : ''), text: p.done ? '✓ 완료' : '표시 중' }),
        state.isHost && p.id !== myKey
          ? el('button', { class: 'rm', type: 'button', 'aria-label': `${p.name} 빼기`, title: '모임에서 빼기', text: '×', onclick: () => removeMember(p) })
          : null,
      ))),
    progressBar(total, doneCount, cap, missing),
  );

  /* 달 제목과 탭 */
  const calhead = el('div', { class: 'calhead' },
    el('h2', { text: `${y}년 ${m + 1}월`, 'aria-live': 'polite' }),
    months.length > 1
      ? el('div', { class: 'tabs', role: 'tablist', 'aria-label': '달 선택' },
          months.map((ym, i) => el('button', {
            type: 'button', role: 'tab', 'data-k': 'tab-' + ym,
            'aria-selected': String(i === state.mi), text: monthName(ym),
            onclick: () => { state.mi = i; state.selected = null; render(); },
          })))
      : null,
  );
  const reveal = !!me?.done;
  const hint = el('p', { class: 'hint', text: reveal
    ? '날짜를 누르면 그날 누가 되고 안 되는지 보여요.'
    : '다른 사람 표시는 가려져 있어요. 내 일정만 보고 안 되는 날에 X를 치세요.' });

  /* 캘린더 */
  const cal = el('div', { class: 'cal' + (reveal ? ' viewing' : ''), 'aria-label': `${y}년 ${m + 1}월 달력` });
  WEEK.forEach((w, i) => cal.append(el('div', { class: 'wd' + (i === 0 ? ' sun' : ''), 'aria-hidden': 'true', text: w })));
  const firstDay = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  for (let i = 0; i < firstDay; i++) cal.append(el('div', { 'aria-hidden': 'true' }));

  for (let d = 1; d <= days; d++) {
    const ds = ymd(y, m, d);
    const unav = unavailableOn(ds);
    const others = unav.filter((p) => p.id !== myKey);
    const mine = myDates.has(ds);
    const past = ds < today;
    const hol = HOLIDAYS[ds];
    const cls = ['cell'];
    if (past) cls.push('past');
    if (ds === today) cls.push('today');
    if (ds === state.selected) cls.push('sel');
    if (hol || weekday(ds) === 0) cls.push('red');
    // 모두 다 표시한 뒤에만 '모두 되는 날'로 확정해서 보여줘요
    if (!past && reveal && allDone && unav.length === 0) cls.push('allok');

    const status = !reveal ? (mine ? '내가 안 됨' : '')
      : unav.length ? `${unav.length}명 안 됨` : allDone ? '모두 가능' : '아직 안 되는 사람 없음';
    const label = `${m + 1}월 ${d}일${hol ? ` ${hol}` : ''}${status ? `, ${status}` : ''}`;
    const cell = el('button', {
      type: 'button',
      class: cls.join(' '),
      style: `--heat:${reveal && total && !past ? (unav.length / total).toFixed(3) : 0}`,
      'data-date': ds,
      'data-k': ds,
      'aria-label': label,
      'aria-pressed': past || reveal ? null : String(mine),
      'aria-haspopup': reveal && !past ? 'dialog' : null,
      disabled: past,
    },
      el('span', { class: 'num', text: d }),
      hol ? el('span', { class: 'hol', text: hol }) : null);
    if (mine && !past) cell.append(xMark(ds, state.justMarked?.has(ds)));
    else if (!past && state.erasing.has(ds)) { const er = eraseMark(ds); if (er) cell.append(er); }
    if (reveal && !past && others.length) {
      cell.append(el('span', { class: 'dots', 'aria-hidden': 'true' },
        others.slice(0, 4).map((p) => el('i', { style: `--c:${colorOf(p.name)}` })),
        others.length > 4 ? `+${others.length - 4}` : null));
    }
    cal.append(cell);
  }
  wireCalendar(cal);

  const legend = !reveal ? null : el('div', { class: 'legend', 'aria-hidden': 'true' },
    el('span', {}, el('span', { class: 'sw heat' }), '진할수록 안 되는 사람이 많아요'),
    el('span', {}, el('span', { class: 'sw ok' }),
      allDone ? '모두 되는 날'
        : missing ? `모두 되는 날 (${cap}명이 다 들어와서 표시하면 보여요)`
        : '모두 되는 날 (다 표시하면 보여요)'),
  );

  /* 다 표시했어요 */
  const done = !!me?.done;
  const donebar = el('div', { class: 'donebar' + (done ? ' is-done' : '') },
    el('p', { text: done ? '✓ 다 표시했어요. 바뀌면 언제든 고칠 수 있어요.' : '안 되는 날을 다 쳤나요? 누르면 모두의 결과가 보여요.' }),
    el('button', { class: 'pill small' + (done ? ' outline' : ''), type: 'button', 'data-k': 'done', text: done ? '아직 더 고칠래요' : '다 표시했어요', onclick: toggleDone }),
  );


  show(
    head, labels, calhead, hint, cal, legend, donebar,
    reveal ? bestCard(today, months, allDone, missing) : lockedCard(),
    el('div', { class: 'foot-links' },
      el('button', { class: 'textbtn', type: 'button', text: '모임에서 나가기', onclick: leaveRoom })),
  );
  state.justMarked = null;
  restoreFocus();
}

/* 몇 명이 다 표시했는지 진행 막대 */
function progressBar(total, doneCount, cap, missing) {
  const goal = Math.max(cap || 0, total);
  if (!goal) return null;
  const text = cap
    ? `${cap}명 중 ${total}명 참여, ${doneCount}명이 다 표시했어요` + (missing ? ` · ${missing}명 더 기다려요` : '')
    : `${total}명 중 ${doneCount}명이 다 표시했어요`;
  return el('div', { class: 'progress' },
    el('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(goal), 'aria-valuenow': String(doneCount), 'aria-label': '다 표시한 사람' },
      el('i', { style: `width:${Math.round((doneCount / goal) * 100)}%` })),
    el('p', { text }));
}

/* 캘린더 터치: 표시 중에는 누르면 X, 쭉 그으면 여러 날.
   다 표시한 뒤에는 누르면 그날 누가 되는지 아래에서 올라와요 (휴대폰엔 마우스 올리기가 없으니까요) */
function wireCalendar(cal) {
  cal.addEventListener('pointerdown', (e) => {
    if (revealed()) return;               // 보기 모드에선 스크롤이 되도록 그대로 둬요
    const cell = e.target.closest('.cell');
    if (!cell || cell.disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (cell.hasPointerCapture?.(e.pointerId)) cell.releasePointerCapture(e.pointerId);
    const ds = cell.dataset.date;
    const mark = !myDateSet().has(ds);   // 처음 누른 칸이 비어 있으면 긋기, X면 지우기
    state.drag = { mark, dates: new Set([ds]), id: e.pointerId };
    state.selected = ds;
    paint(cell, mark);
  });
  cal.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || cell.disabled) return;
    const ds = cell.dataset.date;
    if (revealed()) return openSheet(ds);
    if (e.detail !== 0) return;           // 터치/마우스는 pointerdown에서 이미 처리했어요
    state.selected = ds;                  // 키보드(Enter/Space)로 누른 경우
    setDates([ds], !myDateSet().has(ds));
  });
}

function paint(cell, mark) {
  const ds = cell.dataset.date;
  const x = cell.querySelector('.x:not(.erase)');
  if (mark) {
    cell.querySelector('.x.erase')?.remove();
    state.erasing.delete(ds);
    if (!x) cell.append(xMark(ds, true));
  } else if (x) {
    x.remove();
    startErase(ds);
    if (state.erasing.has(ds)) { const er = eraseMark(ds); if (er) cell.append(er); }
  }
}

window.addEventListener('pointermove', (e) => {
  const drag = state.drag;
  if (!drag || e.pointerId !== drag.id) return;
  const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
  if (!cell || cell.disabled || !app.contains(cell)) return;
  const ds = cell.dataset.date;
  if (drag.dates.has(ds)) return;
  drag.dates.add(ds);
  state.selected = ds;
  paint(cell, drag.mark);
});
function endDrag(e) {
  const drag = state.drag;
  if (!drag || e.pointerId !== drag.id) return;
  state.drag = null;
  state.deferRender = false;
  setDates([...drag.dates], drag.mark, false); // 긋는 동안 이미 그렸어요
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

function nameLabels(arr) {
  return arr.length
    ? el('div', { class: 'names' }, arr.map((p) => el('span', { class: 'label', style: `--c:${colorOf(p.name)}` }, el('span', { class: 'dot' }), p.name)))
    : el('span', { class: 'muted', text: '없음' });
}

function lockedCard() {
  return el('section', { class: 'card locked' },
    el('span', { class: 'lock', 'aria-hidden': 'true' },
      el('i'), el('b')),
    el('p', { class: 'eyebrow', text: '추천 날짜' }),
    el('h3', { text: '다 표시하면 결과가 열려요' }));
}

/* 아래에서 올라오는 날짜 상세 */
let sheetEl = null;
let sheetOpenFor = null;
let sheetReturnFocus = null;

function openSheet(ds) {
  sheetReturnFocus = document.activeElement;
  state.sheet = ds;
  state.selected = ds;
  render();
}
function closeSheet() {
  if (!state.sheet) return;
  state.sheet = null;
  render();
  sheetReturnFocus?.focus?.({ preventScroll: true });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

function renderSheet() {
  const ds = state.screen === 'room' && revealed() ? state.sheet : null;
  if (!ds) {
    if (sheetEl) { sheetEl.remove(); sheetEl = null; }
    sheetOpenFor = null;
    state.sheet = null;
    document.body.classList.remove('sheet-open');
    return;
  }
  const isNew = !sheetEl;
  if (!sheetEl) { sheetEl = el('div', { class: 'sheet-wrap' }); document.body.append(sheetEl); }
  const enter = isNew || sheetOpenFor !== ds;
  sheetOpenFor = ds;
  document.body.classList.add('sheet-open');

  const unav = unavailableOn(ds);
  const rest = state.members.filter((p) => !unav.includes(p));
  const ok = rest.filter((p) => p.done);
  const pending = rest.filter((p) => !p.done);
  const mine = myDateSet().has(ds);
  const hol = HOLIDAYS[ds];
  const closeBtn = el('button', { class: 'sheet-close', type: 'button', 'aria-label': '닫기', text: '×', onclick: closeSheet });

  sheetEl.replaceChildren(
    el('div', { class: 'sheet-backdrop', onclick: closeSheet }),
    el('section', { class: 'sheet' + (enter ? ' enter' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': dateLabel(ds) },
      el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet-head' },
        el('h3', {}, dateLabel(ds), hol ? el('small', { text: hol }) : null),
        closeBtn),
      el('div', { class: 'row' }, el('b', { text: `안 되는 사람 ${unav.length}` }), nameLabels(unav)),
      el('div', { class: 'row' }, el('b', { text: `되는 사람 ${ok.length}` }), nameLabels(ok)),
      pending.length ? el('div', { class: 'row' }, el('b', { text: `표시 중 ${pending.length}` }), nameLabels(pending)) : null,
      el('button', {
        class: 'pill big wide ' + (mine ? 'outline' : 'red'), type: 'button',
        text: mine ? '이 날 X 지우기' : '나도 이 날 안 돼요',
        onclick: () => setDates([ds], !mine),
      }),
    ),
  );
  if (enter) closeBtn.focus({ preventScroll: true });
}

function bestCard(today, months, allDone, missing) {
  const candidates = [];
  for (const ym of months) {
    const [y, m] = parseYM(ym);
    const days = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const ds = ymd(y, m, d);
      if (ds >= today) candidates.push({ ds, unav: unavailableOn(ds) });
    }
  }
  candidates.sort((a, b) => a.unav.length - b.unav.length || a.ds.localeCompare(b.ds));
  const top = candidates.slice(0, 5);
  const allOk = candidates.filter((c) => c.unav.length === 0).length;
  const pending = state.members.filter((p) => !p.done);

  let title, sub;
  if (allDone && allOk) { title = `다 같이 되는 날이 ${allOk}일 있어요`; sub = '빠른 날부터 골라봤어요.'; }
  else if (allDone) { title = '다 같이 되는 날은 없어요'; sub = '안 되는 사람이 적은 날부터 보여줘요.'; }
  else { title = '지금까지 괜찮은 날'; sub = '아직 다 모이지 않아서, 표시한 사람 기준이에요.'; }

  const waiting = [
    missing ? el('span', { class: 'wait', text: `${missing}명 아직 안 들어옴` }) : null,
    ...pending.map((p) => el('span', { class: 'wait', style: `--c:${colorOf(p.name)}` }, el('span', { class: 'dot' }), `${p.name} 표시 중`)),
  ].filter(Boolean);

  return el('section', { class: 'card best-card' + (allDone && allOk ? ' is-ok' : '') },
    el('p', { class: 'eyebrow', text: '추천 날짜' }),
    el('h3', { text: title }),
    el('p', { class: 'sub', text: sub }),
    waiting.length ? el('div', { class: 'waits' }, waiting) : null,
    top.length
      ? el('ol', { class: 'best' }, top.map(({ ds, unav }) => {
          const [, mm, dd] = ds.split('-').map(Number);
          const hol = HOLIDAYS[ds];
          const wd = weekday(ds);
          return el('li', {},
            el('button', { type: 'button', class: unav.length ? '' : 'free', 'data-k': 'best-' + ds, onclick: () => goToDate(ds) },
              el('span', { class: 'tile' + (hol || wd === 0 ? ' red' : '') },
                el('small', { text: `${mm}월` }), el('b', { text: dd })),
              el('span', { class: 'info' },
                el('span', { class: 'day', text: `${WEEK[wd]}요일` }, hol ? el('small', { text: hol }) : null),
                unav.length ? el('span', { class: 'who', text: unav.map((p) => p.name).join(', ') }) : null),
              unav.length
                ? el('span', { class: 'badge no', text: `${unav.length}명 안 돼요` })
                : el('span', { class: 'badge ok', text: allDone ? '✓ 다 돼요' : '✓ X 없음' }),
            ));
        }))
      : el('p', { class: 'muted', text: '고른 기간에 남은 날이 없어요. 방장이 기간을 바꿀 수 있어요.' }),
  );
}

function goToDate(ds) {
  const i = getMonths().indexOf(ds.slice(0, 7));
  if (i !== -1) state.mi = i;
  openSheet(ds);
}

/* 방장: 기간 바꾸기 */
function monthEditor(months) {
  const options = [...new Set([...nextMonths(6), ...months])].sort();
  const draft = state.editDraft;
  return el('div', { class: 'card edit-months' },
    el('h3', { text: '언제쯤 모일까요?' }),
    monthChips(options, draft, (ym) => (draft.has(ym) ? draft.delete(ym) : draft.add(ym))),
    el('h3', { style: 'margin-top:18px', text: '몇 명이 모여요?' }),
    capacityStepper(() => state.editCap, (v) => { state.editCap = v; }),
    el('div', { class: 'actions' },
      el('button', {
        class: 'pill small', type: 'button', text: '저장',
        onclick: async () => {
          if (!draft.size) return toast('모일 달을 하나 이상 골라 주세요.');
          const next = [...draft].sort();
          const capacity = state.editCap;
          state.room = { ...state.room, months: next, capacity };
          state.editingMonths = false;
          state.mi = initialMonthIndex();
          state.selected = null;
          render();
          try { await store.updateRoom(state.roomId, { months: next, capacity }); toast('기간과 인원을 바꿨어요.'); }
          catch (e) { console.error(e); toast('저장하지 못했어요. 다시 시도해 주세요.'); }
        },
      }),
      el('button', { class: 'textbtn', type: 'button', text: '취소', onclick: () => { state.editingMonths = false; render(); } }),
    ),
  );
}

/* 방장: 참여자 빼기 */
async function removeMember(p) {
  if (!confirm(`${p.name}님을 모임에서 뺄까요? 표시한 날짜도 함께 지워져요.`)) return;
  state.members = state.members.filter((x) => x.id !== p.id);
  render();
  try { await store.deleteMember(state.roomId, p.id); toast(`${p.name}님을 뺐어요.`); }
  catch (e) { console.error(e); toast('빼지 못했어요. 다시 시도해 주세요.'); }
}

async function leaveRoom() {
  if (!confirm('모임에서 나갈까요? 내가 표시한 날짜도 지워져요.')) return;
  const key = memberKey(state.me);
  state.members = state.members.filter((x) => x.id !== key);
  forgetMe();
  render();
  try { await store.deleteMember(state.roomId, key); toast('모임에서 나왔어요.'); }
  catch (e) { console.error(e); toast('나가지 못했어요. 다시 시도해 주세요.'); }
}

async function shareLink() {
  const url = `${location.origin}${location.pathname}?room=${state.roomId}`;
  const text = `${state.room.title} 날짜 정해요! 안 되는 날에 X 쳐줘`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: state.room.title, text, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast(DEMO ? '링크를 복사했어요. 체험 모드에선 이 브라우저에서만 열려요.' : '링크를 복사했어요. 친구들에게 보내 주세요.');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 공유 창을 닫은 경우
    window.prompt('이 링크를 복사해서 보내 주세요', url);
  }
}

function renderError(msg) {
  state.screen = 'error';
  show(
    el('section', { class: 'hero' }, el('h1', { text: '언제보까' })),
    el('p', { class: 'muted', style: 'margin-bottom:22px', text: msg }),
    el('a', { href: './', class: 'pill big', text: '새 모임 만들기' }),
  );
}

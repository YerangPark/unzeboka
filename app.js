import { firebaseConfig } from './firebase-config.js';
import { HOLIDAYS } from './holidays.js';

const DEMO = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('YOUR');
const FIREBASE_VERSION = '10.12.2';
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const IN_APP = /NAVER|KAKAOTALK|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp|; wv\)/i.test(navigator.userAgent);
// 초록(모두 되는 날)과 빨강(X 표시)은 의미가 있는 색이라 이름표 색에서 뺐어요
const STICKER_COLORS = ['#1cb0f6', '#ce82ff', '#ff9600', '#ffc800', '#ff86d0', '#2b70c9', '#a56644', '#777777', '#00a8b5', '#6c5ce7'];
const CAP_MIN = 2;
const CAP_MAX = 10;   // 이름표 색 10가지와 맞춰서, 색이 겹치지 않게
const CAP_DEFAULT = 4;
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 모임은 만든 날부터 30일 뒤 사라져요
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
  bestLimit: 3,        // 추천 목록에서 보여줄 개수 (더보기로 늘어나요)
  sheet: null,
  noteEdit: null,      // 메모 쓰는 중: { unit, text }         // 아래에서 올라온 날짜 상세 (결과 보기 모드)
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
// 사람마다 색: 들어올 때 안 쓰는 색 중 랜덤으로 골라 저장해요. 화면에서는 겹치지 않게 한 번 더 정리해요.
const colorIdx = (name) => state.colorMap?.get(memberKey(name)) ?? hash(name) % STICKER_COLORS.length;
const colorOf = (name) => STICKER_COLORS[colorIdx(name)];
const validColor = (c) => Number.isInteger(c) && c >= 0 && c < STICKER_COLORS.length;
function assignColors() {
  const map = new Map();
  const used = new Set();
  // 저장된 색 먼저 (동시에 들어와서 같은 색이 저장됐다면, 이름순으로 앞사람이 가져가요)
  for (const m of state.members) {
    if (validColor(m.color) && !used.has(m.color)) { map.set(m.id, m.color); used.add(m.color); }
  }
  // 색이 없거나 겹친 사람은 남은 색으로
  for (const m of state.members) {
    if (map.has(m.id)) continue;
    let c = hash(m.name) % STICKER_COLORS.length;
    for (let i = 0; i < STICKER_COLORS.length && used.has(c); i++) c = (c + 1) % STICKER_COLORS.length;
    map.set(m.id, c);
    used.add(c);
  }
  state.colorMap = map;
}
function randomFreeColor() {
  const used = new Set(state.members.map((m) => colorIdx(m.name)));
  const free = STICKER_COLORS.map((_, i) => i).filter((i) => !used.has(i));
  const pool = free.length ? free : STICKER_COLORS.map((_, i) => i);
  return pool[Math.floor(Math.random() * pool.length)];
}
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
  // 네이버·카카오톡 같은 앱 안 브라우저는 실시간 연결이 막히는 일이 있어서 롱 폴링으로 연결해요.
  // 일반 브라우저는 막히면 자동으로 롱 폴링으로 바꿔요.
  const db = f.initializeFirestore(initializeApp(firebaseConfig),
    IN_APP ? { experimentalForceLongPolling: true } : { experimentalAutoDetectLongPolling: true });
  const roomRef = (id) => f.doc(db, 'rooms', id);
  return {
    async createRoom(title, months, capacity, slots) {
      const id = newId();
      // 날짜만 모임은 slots를 아예 안 보내요 (예전 보안 규칙과도 호환)
      const data = { title, months, capacity, ...(slots ? { slots: true } : {}), createdAt: f.serverTimestamp() };
      try {
        // 만든 날부터 30일 뒤 자동 삭제 (Firestore TTL)
        await f.setDoc(roomRef(id), { ...data, expireAt: f.Timestamp.fromMillis(Date.now() + ROOM_TTL_MS) });
      } catch (e) {
        if (e?.code === 'permission-denied') await f.setDoc(roomRef(id), data);   // 예전 보안 규칙이면 만료일 없이
        else throw e;
      }
      return id;
    },
    watchRoom(id, cb, onErr) {
      return f.onSnapshot(roomRef(id), (s) => cb(s.exists() ? s.data() : null), onErr);
    },
    async updateRoom(id, patch) { await f.updateDoc(roomRef(id), patch); },
    watchMembers(id, cb, onErr) {
      return f.onSnapshot(f.collection(db, 'rooms', id, 'members'),
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))), onErr);
    },
    async saveMember(id, { name, dates, done, color, notes, expireMs }) {
      const ref = f.doc(db, 'rooms', id, 'members', memberKey(name));
      // 참여자 기록도 모임과 같은 날 지워지도록 (TTL은 하위 기록을 같이 안 지워서 따로 달아요)
      const base = { name, dates, done: !!done, updatedAt: f.serverTimestamp() };
      const extra = { ...(validColor(color) ? { color } : {}), ...(hasNotes(notes) ? { notes } : {}) };
      const exp = expireMs ? { expireAt: f.Timestamp.fromMillis(expireMs) } : {};
      // 보안 규칙이 새 항목을 아직 모르면(예전 규칙) 하나씩 빼고 다시 저장해요
      const tries = [{ ...base, ...extra, ...exp }, { ...base, ...extra }, base];
      for (let i = 0; i < tries.length; i++) {
        try {
          await f.setDoc(ref, tries[i]);
          // 날짜만 저장으로 내려갔으면 메모가 빠졌다고 알려줘요
          if (i === tries.length - 1 && extra.notes) toast('메모는 저장하지 못했어요. 방장에게 알려주세요.');
          break;
        } catch (e) {
          if (e?.code !== 'permission-denied' || i === tries.length - 1) throw e;
        }
      }
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
    async createRoom(title, months, capacity, slots) { const d = read(); const id = newId(); d[id] = { title, months, capacity, slots: !!slots, expireAt: Date.now() + ROOM_TTL_MS, members: {} }; write(d); return id; },
    watchRoom(id, cb) { return listen(() => { const r = read()[id]; cb(r ? { title: r.title, months: r.months, capacity: r.capacity, slots: !!r.slots, expireAt: r.expireAt } : null); }); },
    async updateRoom(id, patch) { const d = read(); if (d[id]) { Object.assign(d[id], patch); write(d); } },
    watchMembers(id, cb) {
      return listen(() => { const r = read()[id]; cb(r ? Object.entries(r.members).map(([k, v]) => ({ id: k, ...v })) : []); });
    },
    async saveMember(id, { name, dates, done, color, notes }) {
      const d = read(); if (!d[id]) return;
      d[id].members[memberKey(name)] = { name, dates, done: !!done, color, notes, updatedAt: Date.now() }; write(d);
    },
    async deleteMember(id, key) { const d = read(); if (d[id]) { delete d[id].members[key]; write(d); } },
  };
}

/* ================= 시작 ================= */

// init()은 파일 맨 끝에서 불러요 (아래에 선언된 값들이 모두 준비된 뒤에)

async function init() {
  try {
    store = DEMO ? demoStore() : await firebaseStore();
  } catch (e) {
    console.error(e);
    return renderError('Firebase에 연결하지 못했어요. firebase-config.js 설정과 인터넷 연결을 확인해 주세요.');
  }

  const id = new URLSearchParams(location.search).get('room');
  if (!id) return renderHome();
  openRoom(id);
}

// 뒤로 가기로 홈 ↔ 모임을 오가면 새로 그려요
window.addEventListener('popstate', () => location.reload());

const LOAD_TIMEOUT_MS = 10000;
function openRoom(id) {
  show(el('p', { class: 'muted', text: '모임을 불러오는 중…' }));
  state.roomId = id;
  state.room = null;
  state.members = [];
  state.me = lsGet('name:' + id);
  state.isHost = lsGet('host:' + id) === '1';
  state.screen = null;
  const onErr = (e) => { console.error(e); toast('실시간 연결이 끊겼어요. 새로고침해 주세요.'); };

  // 모임 정보와 참여자 목록을 동시에 불러오고, 둘 다 오면 화면을 그려요
  let roomReady = false;
  let membersReady = false;
  let lastMembers = [];
  let gone = false;
  const ready = () => roomReady && membersReady;

  // 10초 안에 안 오면: 처음엔 한 번 자동으로 새로고침, 그래도 안 되면 안내
  const retryKey = 'retry:' + id;
  const timer = setTimeout(() => {
    if (ready() || gone) return;
    let retried = false;
    try { retried = sessionStorage.getItem(retryKey) === '1'; sessionStorage.setItem(retryKey, '1'); } catch { retried = true; }
    if (!retried) return location.reload();
    renderError('연결이 느려서 모임을 불러오지 못했어요. 와이파이나 데이터를 확인하고 다시 시도해 주세요.', true);
  }, LOAD_TIMEOUT_MS);
  const loaded = () => {
    clearTimeout(timer);
    try { sessionStorage.removeItem(retryKey); } catch { /* 무시 */ }
  };

  store.watchRoom(id, (room) => {
    if (!room) {
      gone = true;
      clearTimeout(timer);
      forgetRoom(id);
      return renderError(roomReady ? '이 모임은 더 이상 없어요.' : '없는 모임이에요. 받은 링크가 맞는지 확인해 주세요.');
    }
    const firstLoad = !state.room;
    state.room = room;
    if (firstLoad) state.mi = initialMonthIndex();
    // 30일이 지난 모임은 서버에서 지워지기 전이라도 없는 모임으로 보여줘요
    const exp = roomExpiryMs(room);
    if (exp && exp <= Date.now()) {
      gone = true;
      clearTimeout(timer);
      forgetRoom(id);
      return renderError('만든 지 30일이 지나서 사라진 모임이에요.', false, { ghost: true });
    }
    rememberRoom(id, room.title, exp);
    const wasReady = ready();
    roomReady = true;
    if (!membersReady) return;
    if (!wasReady) { loaded(); onMembers(lastMembers); } else render();
  }, (e) => { onErr(e); clearTimeout(timer); renderError('모임을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', true); });

  store.watchMembers(id, (list) => {
    lastMembers = list;
    const wasReady = ready();
    membersReady = true;
    if (!roomReady) return;                 // 모임 정보가 오면 그때 그려요
    if (!wasReady) loaded();
    onMembers(list);
  }, (e) => {
    onErr(e);
    if (!ready()) { clearTimeout(timer); renderError('참여자 목록을 불러오지 못했어요. 다시 시도해 주세요.', true); }
  });
}

function onMembers(list) {
  state.members = list
    .map((m) => ({ ...m, dates: Array.isArray(m.dates) ? m.dates : [], done: !!m.done, notes: cleanNotes(m.notes), updatedMs: toMs(m.updatedAt) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  if (state.me) {
    if (myMember()) state.wasMember = true;
    else if (state.wasMember && savingCount === 0) {
      // 방장이 나를 뺐거나 다른 기기에서 나간 경우.
      // 저장을 다시 시도하는 동안 잠깐 사라져 보일 수 있어서, 조금 기다렸다가 확인해요
      clearTimeout(kickTimer);
      kickTimer = setTimeout(() => {
        if (state.me && state.wasMember && !myMember() && savingCount === 0) {
          forgetMe();
          render();
          toast('모임에서 빠졌어요. 다시 참여할 수 있어요.');
        }
      }, 2500);
    }
  }
  render();
}
let kickTimer;
let savingCount = 0;   // 저장 중인 요청 수

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
  return state.members.every(isDone);
}

/* 자동 완료: 한 번이라도 표시하고, 마지막 표시 후 3분 동안 손대지 않으면 완료로 쳐줘요.
   창을 닫았는지는 휴대폰에서 알기 어려워서, 저장된 마지막 시각으로 계산해요. */
const AUTO_DONE_MS = 3 * 60 * 1000;
function toMs(t) {
  if (typeof t === 'number') return t;
  if (t && typeof t.toMillis === 'function') return t.toMillis();
  return null;
}
function isAutoDone(p) {
  return !p.done && p.dates.length > 0 && p.updatedMs != null && Date.now() - p.updatedMs >= AUTO_DONE_MS;
}
function isDone(p) { return p.done || isAutoDone(p); }
// 시간이 지나 누군가 자동 완료되면 화면을 다시 그려요
let autoDoneSig = '';
setInterval(() => {
  if (state.screen !== 'room') return;
  const sig = state.members.filter(isAutoDone).map((p) => p.id).join(',');
  if (sig !== autoDoneSig) { autoDoneSig = sig; render(); }
}, 15000);

function initialMonthIndex() {
  const ms = getMonths();
  const i = ms.findIndex((ym) => ym >= currentYM());
  return i === -1 ? ms.length - 1 : i;
}

function render() {
  if (state.drag) { state.deferRender = true; return; }
  if (!state.room) return;
  try {
    assignColors();
    if (!state.me) {
      if (state.screen === 'join') fillJoinList();
      else renderJoin();
    } else {
      renderRoom();
    }
    renderSheet();
  } catch (e) {
    // 화면을 그리다 문제가 생겨도 로딩에서 멈추지 않게
    console.error(e);
    renderError('화면을 그리다 문제가 생겼어요. 다시 시도해 주세요.', true);
  }
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
  let slots = false;
  const input = el('input', { type: 'text', maxlength: '40', placeholder: '예: 연말 송년회', id: 'title' });
  const modeBtn = (value, title, sub) => el('button', {
    type: 'button', class: 'mode-opt', 'data-k': 'mode-' + value, 'aria-pressed': String(slots === value),
    onclick: (e) => {
      slots = value;
      e.currentTarget.parentElement.querySelectorAll('.mode-opt').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
    },
  }, el('b', { text: title }), el('small', { text: sub }));
  const btn = el('button', { class: 'pill big wide', type: 'submit', text: '모임 만들기' });

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const title = input.value.replace(/\s+/g, ' ').trim();
      if (!title) { toast('모임 이름을 적어 주세요.'); return input.focus(); }
      if (!picked.size) return toast('모일 달을 하나 이상 골라 주세요.');
      btn.disabled = true;
      try {
        const id = await store.createRoom(title, [...picked].sort(), capacity, slots);
        lsSet('host:' + id, '1');
        // 새로 페이지를 열지 않고 바로 모임 화면으로 (이미 연결된 상태라 빨라요)
        history.pushState(null, '', `?room=${id}`);
        openRoom(id);
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
      el('p', { class: 'muted small', text: '나를 포함한 인원이에요. 모두 표시하면 다 같이 되는 날이 보여요.' })),
    el('div', { class: 'field' }, el('span', { text: '언제쯤 모일까요?' }),
      monthChips(nextMonths(6), picked, (ym) => (picked.has(ym) ? picked.delete(ym) : picked.add(ym))),
      el('p', { class: 'muted small', text: '여러 달을 골라도 돼요. 고른 달 안에서 가장 좋은 날을 찾아줘요.' })),
    el('div', { class: 'field' }, el('span', { text: '어떻게 정할까요?' }),
      el('div', { class: 'modes', role: 'group', 'aria-label': '정하는 방식' },
        modeBtn(false, '날짜만', '하루 단위로 표시'),
        modeBtn(true, '점심·저녁까지', '점심/저녁 따로 표시'))),
    btn,
  );

  const recent = recentRooms();
  show(
    el('section', { class: 'hero' },
      stickers(),
      el('h1', { text: '언제보까' }),
      // 말풍선과 같은 줄 오른쪽 끝에 최근 모임 버튼 (기록이 있을 때만)
      el('div', { class: 'hero-row' },
        el('span', { class: 'caption', text: '안 되는 날에 X만 쳐!' }),
        recent.length ? historyButton(recent.length) : null),
    ),
    demoNotice(),
    form,
  );
}

/* ================= 최근 모임 (이 브라우저에만 저장) ================= */

const RECENT_KEY = 'recentRooms';
const RECENT_MAX = 10;
function recentRooms() {
  try {
    const list = JSON.parse(lsGet(RECENT_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    // 사라진(30일 지난) 모임은 목록에서도 빼요
    const now = Date.now();
    const alive = list.filter((r) => r && typeof r.id === 'string' && (r.exp || (r.at || 0) + ROOM_TTL_MS) > now);
    if (alive.length !== list.length) lsSet(RECENT_KEY, JSON.stringify(alive));
    return alive;
  } catch { return []; }
}
// 모임이 사라지는 시각 (예전 모임은 만든 날 + 30일로 계산, 그것도 없으면 null)
function roomExpiryMs(room) {
  const exp = toMs(room?.expireAt);
  if (exp) return exp;
  const created = toMs(room?.createdAt);
  return created ? created + ROOM_TTL_MS : null;
}
function rememberRoom(id, title, expireMs) {
  const list = recentRooms().filter((r) => r.id !== id);
  list.unshift({ id, title: String(title || '').slice(0, 40), at: Date.now(), exp: expireMs || null });
  lsSet(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
}
function forgetRoom(id) {
  lsSet(RECENT_KEY, JSON.stringify(recentRooms().filter((r) => r.id !== id)));
}

const CLOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
function historyButton(count) {
  const b = el('button', { class: 'history-btn', type: 'button', 'aria-label': `최근 모임 ${count}개 보기`, onclick: openHistory });
  b.innerHTML = CLOCK_SVG;
  return b;
}

let historyEl = null;
function closeHistory() {
  if (!historyEl) return;
  historyEl.remove();
  historyEl = null;
  document.body.classList.remove('sheet-open');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHistory(); });
function openHistory() {
  const firstOpen = !historyEl;
  const list = recentRooms();
  if (!list.length) { closeHistory(); return; }
  if (!historyEl) { historyEl = el('div', { class: 'sheet-wrap' }); document.body.append(historyEl); }
  document.body.classList.add('sheet-open');
  const closeBtn = el('button', { class: 'sheet-close', type: 'button', 'aria-label': '닫기', text: '×', onclick: closeHistory });
  const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };
  historyEl.replaceChildren(
    el('div', { class: 'sheet-backdrop', onclick: closeHistory }),
    el('section', { class: 'sheet' + (firstOpen ? ' enter' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': '최근 모임' },
      el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet-head' }, el('h3', { text: '최근 모임' }), closeBtn),
      el('ul', { class: 'recent-list' }, list.map((r) => el('li', {},
        el('a', { class: 'recent-go', href: `?room=${encodeURIComponent(r.id)}` },
          el('span', { class: 'recent-title', text: r.title || '이름 없는 모임' }),
          el('span', { class: 'recent-meta' },
            lsGet('host:' + r.id) === '1' ? el('span', { class: 'chip', text: '방장' }) : null,
            r.at ? el('span', { text: `${when(r.at)}에 열어봄` }) : null)),
        el('button', {
          class: 'recent-rm', type: 'button', 'aria-label': `${r.title} 목록에서 빼기`, text: '×',
          onclick: () => { forgetRoom(r.id); if (recentRooms().length) openHistory(); else { closeHistory(); renderHome(); } },
        })))),
      el('p', { class: 'recent-note', text: '이 브라우저에서 열어본 모임이에요. ×는 목록에서만 빼요.' }),
    ),
  );
  if (firstOpen) closeBtn.focus({ preventScroll: true });
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
    el('section', { class: 'room-head' }, roomTitle()),
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
    const me = { id: memberKey(name), name, dates: [], done: false, color: randomFreeColor(), notes: {} };
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

// 모임 제목 + 바로 옆에 정원 태그
function roomTitle() {
  const cap = getCapacity();
  return el('div', { class: 'title-row' },
    el('h1', { text: state.room.title }),
    cap ? el('span', { class: 'chip', text: `${cap}명 모임` }) : null);
}

function myMember() { return state.me ? state.members.find((m) => m.id === memberKey(state.me)) : null; }
function ensureMe() {
  let me = myMember();
  if (!me) { me = { id: memberKey(state.me), name: state.me, dates: [], done: false, color: randomFreeColor(), notes: {} }; state.members.push(me); }
  return me;
}
// 다른 사람 표시에 휩쓸리지 않도록, 내가 다 표시하기 전에는 남의 결과를 가려요
function revealed() { return !!myMember()?.done; }
function myDateSet() { const me = myMember(); return new Set(me ? me.dates : []); }
function unavailableOn(u) { return state.members.filter((m) => m.dates.includes(u)); }

/* 표시 단위: '날짜만' 모임은 '2026-12-05', '점심·저녁' 모임은 '2026-12-05:lunch' / ':dinner' */
const SLOT_NAMES = { lunch: '점심', dinner: '저녁' };
function slotMode() { return !!state.room?.slots; }
function unitsOf(ds) { return slotMode() ? [`${ds}:lunch`, `${ds}:dinner`] : [ds]; }
const dsOf = (u) => u.slice(0, 10);
const slotOf = (u) => u.slice(11) || null;
/* 메모: 사람마다 날짜(또는 점심/저녁)별로 한 줄씩 */
const NOTE_MAX = 60;
function cleanNotes(n) {
  if (!n || typeof n !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(n)) if (typeof v === 'string' && v.trim()) out[k] = v.slice(0, NOTE_MAX);
  return out;
}
const hasNotes = (n) => n && typeof n === 'object' && Object.keys(n).length > 0;
function notesOn(u) {
  return state.members.filter((m) => m.notes?.[u]).map((m) => ({ who: m, text: m.notes[u] }));
}
function setNote(u, text) {
  const me = ensureMe();
  const t = text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  me.notes = { ...(me.notes || {}) };
  if (t) me.notes[u] = t; else delete me.notes[u];
  state.noteEdit = null;
  render();
  save(me);
  toast(t ? '메모를 남겼어요.' : '메모를 지웠어요.');
}
function unitLabel(u) { const sl = slotOf(u); return dateLabel(dsOf(u)) + (sl ? ` ${SLOT_NAMES[sl]}` : ''); }

function save(me) {
  me.updatedMs = Date.now();
  // 예전에 색 없이 들어온 사람은, 지금 화면에 보이는 색을 그대로 저장해요
  if (!validColor(me.color)) me.color = colorIdx(me.name);
  savingCount++;
  store.saveMember(state.roomId, { name: me.name, dates: me.dates, done: me.done, color: me.color, notes: me.notes, expireMs: roomExpiryMs(state.room) }).catch((e) => {
    console.error(e);
    toast('저장하지 못했어요. 다시 시도해 주세요.');
  }).finally(() => { savingCount--; });
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
  const doneCount = state.members.filter(isDone).length;
  const cap = getCapacity();
  const missing = cap ? Math.max(0, cap - total) : 0;   // 아직 안 들어온 사람 수
  const allDone = everyoneDone();

  /* 헤더 */
  const head = el('section', { class: 'room-head' }, roomTitle());

  /* 맨 아래: 모임 관리 (초대, 이름 바꾸기, 방장 설정, 나가기) */
  const menuItem = (text, onclick, extra = {}) =>
    el('li', {}, el('button', { type: 'button', onclick, ...extra }, el('span', { text }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
  const manage = el('section', { class: 'manage' },
    el('p', { class: 'eyebrow', text: '모임 관리' }),
    state.editingMonths ? monthEditor(months) : null,
    el('ul', { class: 'menu-list' },
      menuItem('초대 링크 보내기', shareLink, { class: 'blue' }),
      menuItem('이름 바꾸기', () => { forgetMe(); render(); }),
      state.isHost && !state.editingMonths
        ? menuItem('기간·인원 바꾸기', () => { state.editingMonths = true; state.editDraft = new Set(months); state.editCap = cap || Math.max(CAP_MIN, Math.min(CAP_MAX, total)); render(); }, { 'data-k': 'edit-months' })
        : null,
      menuItem('내 모임 새로 만들기', () => { location.href = location.pathname; }),
      menuItem('모임에서 나가기', leaveRoom, { class: 'danger' }),
    ));

  /* 이름표 */
  const labels = el('div', { style: 'margin-top:18px' },
    el('ul', { class: 'labels', 'aria-label': `참여한 사람 ${total}명` },
      state.members.map((p) => el('li', {
        class: 'label' + (p.id === myKey ? ' me' : ''),
        style: `--c:${colorOf(p.name)};--tilt:${tiltOf(p.name)}`,
      },
        el('span', { class: 'dot' }),
        p.name,
        isDone(p)
          ? el('span', { class: 'st done' }, checkMark(), '완료')
          : el('span', { class: 'st', text: '표시 중' }),
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
  const slotTip = slotMode() ? '칸 위쪽은 점심, 아래쪽은 저녁이에요. ' : '';
  const hint = el('p', { class: 'hint', text: slotTip + (reveal
    ? '날짜를 누르면 누가 되고 안 되는지 보여요.'
    : slotMode()
      ? '안 되는 때를 눌러 X를 치세요. 쭉 그으면 여러 칸을 한 번에 칠 수 있어요.'
      : '안 되는 날을 눌러 X를 치세요. 쭉 그으면 여러 날을 한 번에 칠 수 있어요.') });

  /* 캘린더 */
  const cal = el('div', { class: 'cal' + (reveal ? ' viewing' : ''), 'aria-label': `${y}년 ${m + 1}월 달력` });
  WEEK.forEach((w, i) => cal.append(el('div', { class: 'wd' + (i === 0 ? ' sun' : ''), 'aria-hidden': 'true', text: w })));
  const firstDay = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  for (let i = 0; i < firstDay; i++) cal.append(el('div', { 'aria-hidden': 'true' }));

  // 칸 하나(또는 반쪽 하나)의 상태
  const unitState = (u, past) => {
    const unav = unavailableOn(u);
    const mine = myDates.has(u);
    const status = !reveal ? (mine ? '내가 안 됨' : '')
      : unav.length ? `${unav.length}명 안 됨` : allDone ? '모두 가능' : '아직 안 되는 사람 없음';
    return {
      unav, mine, status,
      others: unav.filter((p) => p.id !== myKey),
      allok: !past && reveal && allDone && unav.length === 0,
      heat: reveal && total && !past ? (unav.length / total).toFixed(3) : 0,
    };
  };
  const decorate = (target, u, st, past) => {
    if (st.mine && !past) target.append(xMark(u, state.justMarked?.has(u)));
    else if (!past && state.erasing.has(u)) { const er = eraseMark(u); if (er) target.append(er); }
    // 메모가 있는 칸은 오른쪽 위에 작은 말풍선
    if (reveal && !past && notesOn(u).length) {
      const mk = el('span', { class: 'memo-mark', 'aria-hidden': 'true' });
      mk.innerHTML = MEMO_SVG;
      target.append(mk);
    }
  };
  const split = slotMode();

  for (let d = 1; d <= days; d++) {
    const ds = ymd(y, m, d);
    const past = ds < today;
    const hol = HOLIDAYS[ds];
    const cls = ['cell'];
    if (past) cls.push('past');
    if (ds === today) cls.push('today');
    if (hol || weekday(ds) === 0) cls.push('red');
    const top = [el('span', { class: 'num', text: d }), hol ? el('span', { class: 'hol', text: hol }) : null];

    if (!split) {
      const st = unitState(ds, past);
      if (ds === state.selected) cls.push('sel');
      // 모두 다 표시한 뒤에만 '모두 되는 날'로 확정해서 보여줘요
      if (st.allok) cls.push('allok');
      const cell = el('button', {
        type: 'button', class: cls.join(' '), style: `--heat:${st.heat}`,
        'data-unit': ds, 'data-k': ds,
        'aria-label': `${m + 1}월 ${d}일${hol ? ` ${hol}` : ''}${st.status ? `, ${st.status}` : ''}`,
        'aria-pressed': past || reveal ? null : String(st.mine),
        'aria-haspopup': reveal && !past ? 'dialog' : null,
        disabled: past,
      }, top);
      decorate(cell, ds, st, past);
      // 다른 사람이 3명까지면 색 점만, 4명부터는 점 2개 + '+나머지' (좁은 칸에 들어가게)
      if (reveal && !past && st.others.length) {
        const many = st.others.length > 3;
        const shown = many ? st.others.slice(0, 2) : st.others;
        cell.append(el('span', { class: 'dots', 'aria-hidden': 'true' },
          shown.map((p) => el('i', { style: `--c:${colorOf(p.name)}` })),
          many ? el('b', { text: `+${st.others.length - 2}` }) : null));
      }
      cal.append(cell);
      continue;
    }

    // 점심·저녁 모임: 칸 위쪽은 점심, 아래쪽은 저녁
    cls.push('split');
    const cell = el('div', { class: cls.join(' ') }, el('span', { class: 'cell-head', 'aria-hidden': 'true' }, top));
    for (const u of unitsOf(ds)) {
      const st = unitState(u, past);
      const hcls = ['half', slotOf(u)];
      if (u === state.selected) hcls.push('sel');
      if (st.allok) hcls.push('allok');
      const half = el('button', {
        type: 'button', class: hcls.join(' '), style: `--heat:${st.heat}`,
        'data-unit': u, 'data-k': u,
        'aria-label': `${m + 1}월 ${d}일 ${SLOT_NAMES[slotOf(u)]}${hol ? ` ${hol}` : ''}${st.status ? `, ${st.status}` : ''}`,
        'aria-pressed': past || reveal ? null : String(st.mine),
        'aria-haspopup': reveal && !past ? 'dialog' : null,
        disabled: past,
      });
      decorate(half, u, st, past);
      cell.append(half);
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
    done
      ? el('p', { class: 'done-msg' }, whoIcon('ok'), el('span', { text: '다 표시했어요. 바뀌면 언제든 고칠 수 있어요.' }))
      : el('p', { text: '안 되는 날을 다 쳤나요? 누르면 모두의 결과가 보여요.' }),
    el('div', { class: 'done-actions' },
      // 다 표시했는데 아직 안 들어온 사람이 있으면, 바로 초대할 수 있게
      done && missing > 0
        ? el('button', { class: 'pill small', type: 'button', 'data-k': 'invite', text: '친구 초대하기', onclick: shareLink })
        : null,
      el('button', { class: 'pill small' + (done ? ' outline' : ''), type: 'button', 'data-k': 'done', text: done ? '아직 더 고칠래요' : '다 표시했어요', onclick: toggleDone })),
  );


  show(
    head, labels, calhead, hint, cal, legend, donebar,
    reveal ? bestCard(today, months, allDone, missing) : lockedCard(),
    manage,
  );
  state.justMarked = null;
  restoreFocus();
}

/* 몇 명이 다 표시했는지 진행 막대 */
function progressBar(total, doneCount, cap, missing) {
  const goal = Math.max(cap || 0, total);
  if (!goal) return null;
  // 막대와 같은 숫자를 짧게. 누가 표시 중인지는 이름표에서 보여요
  const allDone = !missing && doneCount >= goal;
  const line = allDone
    ? el('p', {}, el('strong', { text: `${goal}명 모두 완료!` }))
    : el('p', {}, el('strong', { text: `${doneCount}/${goal}명 완료` }),
        missing ? ` · ${missing}명 아직 안 들어왔어요` : null);
  return el('div', { class: 'progress' + (allDone ? ' all-done' : '') },
    el('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(goal), 'aria-valuenow': String(doneCount), 'aria-label': '다 표시한 사람' },
      el('i', { style: `width:${Math.round((doneCount / goal) * 100)}%` })),
    line);
}

/* 캘린더 터치: 표시 중에는 누르면 X, 쭉 그으면 여러 날.
   다 표시한 뒤에는 누르면 그날 누가 되는지 아래에서 올라와요 (휴대폰엔 마우스 올리기가 없으니까요) */
function wireCalendar(cal) {
  cal.addEventListener('pointerdown', (e) => {
    if (revealed()) return;               // 보기 모드에선 스크롤이 되도록 그대로 둬요
    const t = e.target.closest('[data-unit]');
    if (!t || t.disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (t.hasPointerCapture?.(e.pointerId)) t.releasePointerCapture(e.pointerId);
    const u = t.dataset.unit;
    const mark = !myDateSet().has(u);    // 처음 누른 칸이 비어 있으면 긋기, X면 지우기
    state.drag = { mark, dates: new Set([u]), id: e.pointerId };
    state.selected = u;
    paint(t, mark);
  });
  cal.addEventListener('click', (e) => {
    const t = e.target.closest('[data-unit]');
    if (!t || t.disabled) return;
    const u = t.dataset.unit;
    if (revealed()) return openSheet(u);
    if (e.detail !== 0) return;           // 터치/마우스는 pointerdown에서 이미 처리했어요
    state.selected = u;                   // 키보드(Enter/Space)로 누른 경우
    setDates([u], !myDateSet().has(u));
  });
}

function paint(t, mark) {
  const u = t.dataset.unit;
  const x = t.querySelector('.x:not(.erase)');
  if (mark) {
    t.querySelector('.x.erase')?.remove();
    state.erasing.delete(u);
    if (!x) t.append(xMark(u, true));
  } else if (x) {
    x.remove();
    startErase(u);
    if (state.erasing.has(u)) { const er = eraseMark(u); if (er) t.append(er); }
  }
}

window.addEventListener('pointermove', (e) => {
  const drag = state.drag;
  if (!drag || e.pointerId !== drag.id) return;
  const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-unit]');
  if (!t || t.disabled || !app.contains(t)) return;
  const u = t.dataset.unit;
  if (drag.dates.has(u)) return;
  drag.dates.add(u);
  state.selected = u;
  paint(t, drag.mark);
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

/* 날짜 상세: 되는 사람 / 안 되는 사람 */
const WHO_PATH = {
  no: '<path d="M8 8l8 8M16 8l-8 8"/>',
  ok: '<path d="M7 12.5l3.3 3.3L17 9"/>',
};
// 원 없이 체크 모양만 (이름표 '완료' 앞)
function checkMark() {
  const i = el('span', { class: 'check-mark', 'aria-hidden': 'true' });
  i.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 8.6l3.2 3.1L13 4.6"/></svg>';
  return i;
}
function whoIcon(kind) {
  const i = el('span', { class: 'who-icon' });
  i.innerHTML = `<svg viewBox="0 0 24 24">${WHO_PATH[kind]}</svg>`;
  return i;
}
function whoRow(kind, title, people) {
  return el('div', { class: `who-row ${kind}`, role: 'group', 'aria-label': `${title} ${people.length}명` },
    el('div', { class: 'who-head', 'aria-hidden': 'true' },
      whoIcon(kind),
      el('span', { class: 'who-title', text: title }),
      el('span', { class: 'who-count', text: people.length })),
    people.length
      ? el('div', { class: 'who-names' }, people.map((p) =>
          el('span', { class: 'who-name' + (p.name === state.me ? ' me' : '') },
            el('span', { class: 'dot', style: `--c:${colorOf(p.name)}` }), p.name)))
      : el('span', { class: 'who-empty', text: '없음' }));
}
function waitingNote(pending) {
  const cap = getCapacity();
  const missing = cap ? Math.max(0, cap - state.members.length) : 0;
  const parts = [
    pending.length ? `${pending.map((p) => p.name).join(', ')} 표시 중` : null,
    missing ? `${missing}명 아직 안 들어옴` : null,
  ].filter(Boolean);
  return parts.length ? el('p', { class: 'who-wait', text: parts.join(' · ') }) : null;
}

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
  if (state.noteEdit?.unit !== ds) state.noteEdit = null;
  state.sheet = ds;
  state.selected = ds;
  render();
}
function closeSheet() {
  if (!state.sheet) return;
  state.sheet = null;
  state.noteEdit = null;
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
  const ok = rest.filter(isDone);
  const pending = rest.filter((p) => !isDone(p));
  const mine = myDateSet().has(ds);
  const hol = HOLIDAYS[dsOf(ds)];
  const when = slotOf(ds) ? '이때' : '이 날';
  const notes = notesOn(ds);
  const myNote = myMember()?.notes?.[ds] || '';
  const editing = state.noteEdit?.unit === ds;
  const hadFocus = document.activeElement?.classList?.contains('note-input');
  const closeBtn = el('button', { class: 'sheet-close', type: 'button', 'aria-label': '닫기', text: '×', onclick: closeSheet });

  sheetEl.replaceChildren(
    el('div', { class: 'sheet-backdrop', onclick: closeSheet }),
    el('section', { class: 'sheet' + (enter ? ' enter' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': unitLabel(ds) },
      el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet-head' },
        el('h3', {}, unitLabel(ds), hol ? el('small', { text: hol }) : null),
        closeBtn),
      el('div', { class: 'who' },
        whoRow('no', '안 돼요', unav),
        whoRow('ok', '돼요', ok)),
      waitingNote(pending),
      notes.length ? el('ul', { class: 'notes', 'aria-label': '메모' }, notes.map(({ who, text }) =>
        el('li', { class: who.name === state.me ? 'me' : '' },
          memoIcon(),
          el('span', { class: 'note-who', text: who.name }),
          el('span', { class: 'note-text', text })))) : null,
      editing ? noteEditor(ds) : null,
      // 메모를 쓰는 동안에는 메모 입력에만 집중하도록 아래 버튼을 숨겨요
      editing ? null : el('div', { class: 'sheet-actions' },
        el('button', {
          class: 'pill big ' + (mine ? 'outline' : 'red'), type: 'button',
          text: mine ? `${when} X 지우기` : `나도 ${when} 안 돼요`,
          onclick: () => setDates([ds], !mine),
        }),
        memoButton(ds, myNote)),
    ),
  );
  const input = sheetEl.querySelector('.note-input');
  if (input && (hadFocus || state.noteEdit?.focus)) {
    if (state.noteEdit) state.noteEdit.focus = false;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  } else if (enter) closeBtn.focus({ preventScroll: true });
}

// 파란 말풍선 (아래 두께로 듀오링고처럼 도톰하게)
const MEMO_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true">' +
  '<path d="M6 7h20a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H14l-5 4.5V23H6a3 3 0 0 1-3-3V10a3 3 0 0 1 3-3z" fill="#1899d6"/>' +
  '<path d="M6 5h20a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H14l-5 4.5V21H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z" fill="#1cb0f6"/>' +
  '<path d="M8.5 11h15M8.5 15.5h10" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>' +
  '</svg>';
function memoIcon() {
  const icon = el('span', { class: 'memo-icon', 'aria-hidden': 'true' });
  icon.innerHTML = MEMO_SVG;
  return icon;
}
function memoButton(u, myNote) {
  return el('button', {
    class: 'pill big outline memo-btn', type: 'button', 'data-k': 'memo',
    text: myNote ? '메모 고치기' : '메모',
    onclick: () => { state.noteEdit = { unit: u, text: myNote, focus: true }; render(); },
  });
}

function noteEditor(u) {
  const ne = state.noteEdit;
  const had = !!myMember()?.notes?.[u];
  const count = el('span', { class: 'note-count', text: `${ne.text.length}/${NOTE_MAX}` });
  const input = el('textarea', {
    class: 'note-input', rows: '2', maxlength: String(NOTE_MAX),
    placeholder: '예: 7시 이후엔 가능해요',
    oninput: (e) => { ne.text = e.target.value; count.textContent = `${ne.text.length}/${NOTE_MAX}`; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); setNote(u, ne.text); } },
  });
  input.value = ne.text;
  return el('div', { class: 'note-editor' },
    input,
    el('div', { class: 'note-bar' },
      count,
      el('div', { class: 'note-btns' },
        el('button', { class: 'textbtn', type: 'button', text: '취소', onclick: () => { state.noteEdit = null; render(); } }),
        had ? el('button', { class: 'textbtn danger', type: 'button', text: '지우기', onclick: () => setNote(u, '') }) : null,
        el('button', { class: 'pill small', type: 'button', text: '저장', onclick: () => setNote(u, ne.text) }))));
}

function bestCard(today, months, allDone, missing) {
  const candidates = [];
  for (const ym of months) {
    const [y, m] = parseYM(ym);
    const days = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const ds = ymd(y, m, d);
      if (ds >= today) for (const u of unitsOf(ds)) candidates.push({ ds: u, unav: unavailableOn(u), i: candidates.length });
    }
  }
  // 안 되는 사람이 적은 순, 같으면 날짜·시간 순 (점심이 저녁보다 먼저)
  candidates.sort((a, b) => a.unav.length - b.unav.length || a.i - b.i);
  const top = candidates.slice(0, state.bestLimit);
  const more = candidates.length - top.length;
  const allOk = candidates.filter((c) => c.unav.length === 0).length;
  const pending = state.members.filter((p) => !isDone(p));

  let title, sub;
  // '날'은 받침이 있어서 이/은, '때'는 받침이 없어서 가/는
  const unitWord = slotMode() ? '때' : '날';
  const [subj, topic] = slotMode() ? ['가', '는'] : ['이', '은'];
  const countWord = slotMode() ? `${allOk}번` : `${allOk}일`;
  if (allDone && allOk) { title = `다 같이 되는 ${unitWord}${subj} ${countWord} 있어요`; sub = '빠른 순서로 골라봤어요.'; }
  else if (allDone) { title = `다 같이 되는 ${unitWord}${topic} 없어요`; sub = '안 되는 사람이 적은 순서로 보여줘요.'; }
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
          const day = dsOf(ds);
          const [, mm, dd] = day.split('-').map(Number);
          const hol = HOLIDAYS[day];
          const wd = weekday(day);
          const sl = slotOf(ds);
          return el('li', {},
            el('button', { type: 'button', class: unav.length ? '' : 'free', 'data-k': 'best-' + ds, onclick: () => goToDate(ds) },
              el('span', { class: 'tile' + (hol || wd === 0 ? ' red' : '') },
                el('small', { text: `${mm}월` }), el('b', { text: dd })),
              el('span', { class: 'info' },
                el('span', { class: 'day', text: `${WEEK[wd]}요일${sl ? ` ${SLOT_NAMES[sl]}` : ''}` }, hol ? el('small', { text: hol }) : null),
                unav.length ? el('span', { class: 'unav', text: unav.map((p) => p.name).join(', ') }) : null),
              unav.length
                ? el('span', { class: 'badge no', text: `${unav.length}명 안 돼요` })
                : el('span', { class: 'badge ok', text: allDone ? '✓ 다 돼요' : '✓ X 없음' }),
            ));
        }))
      : el('p', { class: 'muted', text: '고른 기간에 남은 날이 없어요. 방장이 기간을 바꿀 수 있어요.' }),
    more > 0
      ? el('button', { class: 'more-btn', type: 'button', 'data-k': 'best-more',
          text: `더보기 (${more}개 더 있어요)`,
          onclick: () => { state.bestLimit += 3; render(); } })
      : state.bestLimit > 3 && top.length > 3
        ? el('button', { class: 'more-btn', type: 'button', 'data-k': 'best-more', text: '접기',
            onclick: () => { state.bestLimit = 3; render(); } })
        : null,
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

// 사라진 모임: 메인 달력 캐릭터가 유령이 됐어요
function ghostBuddy() {
  const w = el('div', { class: 'ghost-wrap', 'aria-hidden': 'true' });
  w.innerHTML =
    '<svg class="ghost" viewBox="0 0 100 110">' +
      // 몸통 (아래가 물결치는 유령 꼬리)
      '<path d="M14 34a18 18 0 0 1 18-18h36a18 18 0 0 1 18 18v52q-6 9-12 0q-6 9-12 0q-6 9-12 0q-6 9-12 0q-6 9-12 0q-6 9-12 0z" fill="#fff" stroke="#e5e5e5" stroke-width="4" stroke-linejoin="round"/>' +
      // 흐릿해진 초록 머리와 고리
      '<path d="M14 34a18 18 0 0 1 18-18h36a18 18 0 0 1 18 18v6H14z" fill="#58cc02" opacity=".35"/>' +
      '<rect x="32" y="6" width="8" height="18" rx="4" fill="#58a700" opacity=".35"/><rect x="60" y="6" width="8" height="18" rx="4" fill="#58a700" opacity=".35"/>' +
      // 졸린 듯 감은 눈, 동그랗게 놀란 입
      '<path d="M33 58q5 5 10 0M57 58q5 5 10 0" stroke="#afafaf" stroke-width="4" fill="none" stroke-linecap="round"/>' +
      '<ellipse cx="50" cy="72" rx="4.5" ry="5.5" fill="#afafaf"/>' +
      // 볼 터치
      '<circle cx="28" cy="66" r="4" fill="#ff86d0" opacity=".25"/><circle cx="72" cy="66" r="4" fill="#ff86d0" opacity=".25"/>' +
    '</svg>' +
    '<span class="ghost-shadow"></span>' +
    '<span class="ghost-z z1">z</span><span class="ghost-z z2">z</span>';
  return w;
}

function renderError(msg, canRetry = false, opts = {}) {
  state.screen = 'error';
  show(
    el('section', { class: 'hero' }, el('h1', { text: '언제보까' })),
    opts.ghost ? ghostBuddy() : null,
    el('p', { class: 'muted' + (opts.ghost ? ' ghost-msg' : ''), style: 'margin-bottom:22px', text: msg }),
    canRetry
      ? el('div', { class: 'error-actions' },
          el('button', { class: 'pill big', type: 'button', text: '다시 시도', onclick: () => location.reload() }),
          el('a', { href: './', class: 'textbtn', text: '새 모임 만들기' }))
      : el('div', { class: opts.ghost ? 'ghost-actions' : '' }, el('a', { href: './', class: 'pill big', text: '새 모임 만들기' })),
  );
}

init();

// 공공데이터포털 '한국천문연구원_특일 정보' API로 올해·내년 공휴일을 받아 holidays.js를 새로 써요.
// GitHub Actions가 매달 실행해요. (.github/workflows/holidays.yml)
//
// 필요한 환경 변수
//   DATA_GO_KR_KEY   공공데이터포털 인증키 (일반 인증키 Decoding 값). GitHub 비밀 값으로 넣어요.
//   HOLIDAY_API_BASE (선택) 테스트용으로 API 주소를 바꿀 때
//
// 받아오지 못한 해(아직 발표 전이거나 오류)는 기존 holidays.js 내용을 그대로 둬요.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const KEY = process.env.DATA_GO_KR_KEY;
const BASE = process.env.HOLIDAY_API_BASE
  || 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'holidays.js');

if (!KEY) {
  console.error('DATA_GO_KR_KEY 비밀 값이 없어요. GitHub 저장소 Settings > Secrets에 추가해 주세요.');
  process.exit(1);
}

// 화면에 보이는 이름을 짧고 익숙하게
const RENAME = {
  '1월1일': '신정',
  '기독탄신일': '성탄절',
  '근로자의 날': '노동절',
  '근로자의날': '노동절',
  '전국동시지방선거': '지방선거',
};
const cleanName = (n) => {
  const name = String(n).trim();
  if (name.startsWith('대체')) return '대체공휴일';
  return RENAME[name] ?? name;
};

async function fetchYear(year) {
  const url = new URL(BASE);
  url.search = new URLSearchParams({
    serviceKey: KEY, solYear: String(year), numOfRows: '100', _type: 'json',
  }).toString();
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`${year}년: HTTP ${res.status}`);
  let data;
  try { data = JSON.parse(text); } catch {
    // 인증키 오류 등은 XML로 와요
    const msg = text.match(/<returnAuthMsg>([^<]+)/)?.[1] || text.match(/<resultMsg>([^<]+)/)?.[1] || '알 수 없는 응답';
    throw new Error(`${year}년: ${msg}`);
  }
  const header = data?.response?.header;
  if (header && header.resultCode !== '00') throw new Error(`${year}년: ${header.resultMsg}`);
  let items = data?.response?.body?.items?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  return items
    .filter((it) => it.isHoliday === 'Y')
    .map((it) => {
      const d = String(it.locdate);
      return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, name: cleanName(it.dateName) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 설날·추석 3일 연휴는 가운데 날만 '설날/추석', 앞뒤는 '설날 연휴/추석 연휴'
function markLongHolidays(list) {
  const out = list.map((x) => ({ ...x }));
  const dayNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
  for (const name of ['설날', '추석']) {
    const run = out.filter((x) => x.name === name);
    for (let i = 0; i + 2 < run.length; i++) {
      const [a, b, c] = run.slice(i, i + 3);
      if (dayNum(b.date) - dayNum(a.date) === 1 && dayNum(c.date) - dayNum(b.date) === 1) {
        a.name = `${name} 연휴`; c.name = `${name} 연휴`;
        i += 2;
      }
    }
  }
  return out;
}

// 기존 holidays.js를 글자로 읽어서 날짜·이름만 꺼내요 (package.json 없이도 되게)
const merged = {};
for (const m of (await readFile(FILE, 'utf8')).matchAll(/'(\d{4}-\d{2}-\d{2})'\s*:\s*'([^']*)'/g)) merged[m[1]] = m[2];

const MIN_PER_YEAR = Number(process.env.HOLIDAY_MIN_PER_YEAR || 10);
const thisYear = new Date().getFullYear();
let updated = 0;
let failed = 0;
for (const year of [thisYear, thisYear + 1]) {
  try {
    const list = markLongHolidays(await fetchYear(year));
    if (!list.length) { console.log(`${year}년: 아직 발표되지 않았어요. 기존 내용을 그대로 둬요.`); continue; }
    // 한 해 공휴일은 보통 15일 이상이에요. 너무 적으면 응답이 잘못된 걸로 보고 건너뛰어요
    if (list.length < MIN_PER_YEAR) { console.log(`${year}년: ${list.length}일만 와서 이상해요. 기존 내용을 그대로 둬요.`); continue; }
    for (const k of Object.keys(merged)) if (k.startsWith(`${year}-`)) delete merged[k];
    for (const { date, name } of list) merged[date] = name;
    console.log(`${year}년: 공휴일 ${list.length}일을 받았어요.`);
    updated++;
  } catch (e) {
    failed++;
    console.error(`받아오지 못했어요. ${e.message} (기존 내용을 그대로 둬요)`);
  }
}

// 2년보다 오래된 공휴일은 정리해요 (모임은 앞으로의 날짜만 쓰니까요)
for (const k of Object.keys(merged)) if (+k.slice(0, 4) < thisYear - 1) delete merged[k];

const years = [...new Set(Object.keys(merged).map((k) => k.slice(0, 4)))].sort();
const body = years.map((y) => {
  const lines = Object.keys(merged).filter((k) => k.startsWith(y)).sort()
    .map((k) => `  '${k}': '${merged[k].replace(/'/g, "\\'")}',`);
  return `  // ${y}\n${lines.join('\n')}`;
}).join('\n\n');

const out = `// 대한민국 관공서 공휴일 (한국천문연구원 특일 정보 기준)
// GitHub Actions가 매달 자동으로 받아와요. 직접 고치지 않아도 돼요. (scripts/update-holidays.mjs)
export const HOLIDAYS = {
${body}
};
`;

if (!updated) {
  console.log('새로 받은 공휴일이 없어서 holidays.js는 그대로 둬요.');
  if (failed) process.exit(1);
  process.exit(0);
}
await writeFile(FILE, out);
console.log(`holidays.js를 다시 썼어요. (${updated}개 해 갱신)`);

// 만든 지 30일이 지난 모임을 Firestore에서 지워요 (참여자 기록까지 함께).
// GitHub Actions가 매일 한 번 실행해요. (.github/workflows/cleanup.yml)
//
// 필요한 환경 변수
//   FIREBASE_SERVICE_ACCOUNT  Firebase 서비스 계정 키(JSON 전체 문자열). GitHub 비밀 값으로 넣어요.
//   DRY_RUN=1                 지우지 않고 지울 대상만 보여줘요 (선택)
//
// 관리자 키로 접속하므로 보안 규칙과 상관없이 지울 수 있어요. 키는 절대 저장소에 올리지 마세요.
//
// 저장소가 공개라 Actions 로그도 누구나 볼 수 있어요.
// 모임 ID는 곧 모임 링크라서, 로그에는 ID와 모임 이름을 남기지 않고 개수와 만든 날짜만 적어요.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // app.js의 ROOM_TTL_MS와 같아요
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT 비밀 값이 없어요. GitHub 저장소 Settings > Secrets에 추가해 주세요.');
  process.exit(1);
}

let credentials;
try {
  credentials = JSON.parse(raw);
} catch {
  console.error('FIREBASE_SERVICE_ACCOUNT가 올바른 JSON이 아니에요. 키 파일 내용을 통째로 붙여넣었는지 확인해 주세요.');
  process.exit(1);
}

initializeApp({ credential: cert(credentials) });
const db = getFirestore();

const now = Date.now();
const cutoff = Timestamp.fromMillis(now - ROOM_TTL_MS);

// 1) 만든 지 30일 지난 모임 (예전 모임 포함, 모든 모임에 createdAt이 있어요)
// 2) 삭제 예정일(expireAt)이 지난 모임
// 3) 방장이 지우다 중간에 멈춘 모임 (삭제 표시만 남은 것)
const [byCreated, byExpire, byDeleted] = await Promise.all([
  db.collection('rooms').where('createdAt', '<=', cutoff).get(),
  db.collection('rooms').where('expireAt', '<=', Timestamp.fromMillis(now)).get(),
  db.collection('rooms').where('deleted', '==', true).get(),
]);

const targets = new Map();
for (const snap of [byCreated, byExpire, byDeleted]) {
  for (const doc of snap.docs) targets.set(doc.id, doc);
}

console.log(`${DRY_RUN ? '[미리보기] ' : ''}지울 모임 ${targets.size}개`);

let deleted = 0;
let failed = 0;
for (const doc of targets.values()) {
  const { createdAt } = doc.data();
  const made = createdAt?.toDate?.().toISOString().slice(0, 10) ?? '날짜 없음';
  console.log(`- 만든 날 ${made}`);
  if (DRY_RUN) continue;
  try {
    // 모임 문서와 그 아래 members 기록까지 함께 지워요
    await db.recursiveDelete(doc.ref);
    deleted++;
  } catch (e) {
    // 오류 메시지에 문서 경로(모임 ID)가 들어 있을 수 있어서 코드만 남겨요
    failed++;
    console.log(`  삭제 실패 (${e?.code ?? '알 수 없는 오류'})`);
  }
}

console.log(DRY_RUN ? '미리보기라 아무것도 지우지 않았어요.' : `${deleted}개 모임을 지웠어요.${failed ? ` ${failed}개는 실패했어요.` : ''}`);
if (failed) process.exitCode = 1;

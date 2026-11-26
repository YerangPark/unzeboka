# 언제보까

친구들이 각자 안 되는 날에 X를 치면, 다 같이 되는 날을 찾아주는 모임 날짜 정하기 서비스.

## 파일 구성

- `index.html` 화면 뼈대, 링크 미리보기(OG) 설정
- `style.css` 디자인
- `app.js` 동작 (캘린더, 드래그로 X 긋기, 실시간 공유, 추천 날짜, 방장 기능)
- `holidays.js` 공휴일 목록 (2026~2027년)
- `firebase-config.js` Firebase 연결 정보 (직접 채워야 함)
- `firestore.rules` 데이터베이스 보안 규칙
- `og-image.png`, `favicon.svg` 링크 미리보기 이미지와 아이콘

## 1. 내 컴퓨터에서 먼저 확인하기 (체험 모드)

`firebase-config.js`를 채우기 전에는 체험 모드라서 기록이 이 브라우저에만 저장돼요.
파일을 더블클릭하면 동작하지 않으니 로컬 서버로 여세요.

```
npx serve .
```

같은 브라우저에서 탭을 여러 개 열고 "이름 바꾸기"로 다른 사람인 척 참여하면 실시간 공유를 흉내 낼 수 있어요.

## 2. Firebase 설정

1. https://console.firebase.google.com 에서 **프로젝트 추가**
2. **Firestore Database > 데이터베이스 만들기** (위치 `asia-northeast3 (서울)`, 프로덕션 모드)
3. Firestore **규칙** 탭에 `firestore.rules` 내용을 붙여넣고 **게시**
4. 프로젝트 설정 > **내 앱 > 웹(</>)** 으로 앱 등록
5. 나오는 `firebaseConfig` 값을 `firebase-config.js`에 붙여넣기

## 3. Vercel 배포

1. 이 폴더를 GitHub 저장소로 올리기
2. https://vercel.com > **Add New > Project** > 저장소 Import
3. Framework Preset은 **Other**, 빌드 설정은 비워두고 **Deploy**

## 4. 카카오톡 미리보기 연결

1. 배포된 주소를 확인 (예: `https://unzeboka.vercel.app`)
2. `index.html`의 `SITE_URL`을 그 주소로 바꾸고 다시 올리기
   (`<meta property="og:image" content="https://unzeboka.vercel.app/og-image.png">`)
3. 카카오톡은 미리보기를 오래 기억해요. 바꾼 게 안 보이면
   카카오 개발자 사이트의 공유 디버거(developers.kakao.com/tool/debugger/sharing)에서 주소를 넣고 캐시를 초기화하세요.

미리보기는 모든 모임에 같은 문구로 나와요. 모임 이름까지 미리보기에 넣으려면 서버에서 HTML을 만들어야 해서 다음 단계로 남겨뒀어요.

## 기능 요약

- 모임을 만들 때 모일 달을 고름 (여러 달 가능). 방장은 나중에 "기간 바꾸기"로 수정
- 날짜를 누르면 X, 쭉 그으면 여러 날에 한 번에 X. X에서 시작해 그으면 지우기
- "다 표시했어요"로 완료 표시. 모두 완료해야 '모두 되는 날' 초록 줄이 나타남
- 날짜 상세: 안 되는 사람, 되는 사람, 아직 표시 중인 사람
- 추천: 고른 기간 전체에서 안 되는 사람이 적은 날 순서
- 방장(모임을 만든 브라우저)은 이름표의 ×로 사람을 뺄 수 있음. 누구나 "모임에서 나가기" 가능
- 공휴일과 일요일은 숫자를 주황색으로 표시

## 알아둘 점

- 로그인이 없어서 링크를 아는 사람은 다른 사람 이름으로도 X를 칠 수 있어요.
- 방장 표시는 모임을 만든 브라우저에만 저장돼요. 브라우저 기록을 지우면 방장 기능이 사라져요.
- `holidays.js`는 매년 6월 말 다음 해 월력요항이 발표되면 추가해 주세요.

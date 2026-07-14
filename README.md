# 📋 m-event (이벤트/이슈 관리 시스템)

> **한 줄 설명**: M-SMART 점검 앱에서 직원이 "특이사항 메모"를 적으면 자동으로 이슈가 생성되고, 담당자가 조치 → 완료까지 처리 과정을 추적하면서 이메일 알림도 자동으로 받는 시스템이에요.

---

## 🧸 이게 뭐 하는 거예요?

처음엔 "이벤트 기록 게시판"인 줄 알았는데, 실제로는 **학교 보건실 사고 처리 시스템**에 더 가까워요!

- 학생이 다치면 → 보건 일지에 자동 기록되고
- 담당 선생님에게 "○○가 다쳤어요!" 알림이 가고
- "치료 중"이라고 표시했다가, 다 나으면 "완료" 처리하고
- 3일 넘게 안 끝나면 "아직도 안 끝났어요?" 하고 다시 알려주는 시스템

이게 m-event가 하는 일이에요. 단순 기록이 아니라 **발생 → 조치중 → 완료**라는 흐름(워크플로우) 전체를 관리해요.

---

## 🗺️ 어디서 볼 수 있나요?

| 항목 | 내용 |
|---|---|
| 접속 주소 | `m-smart-0804.web.app` |
| 호스팅 | Firebase Hosting + Firebase Functions |
| 화면 파일 | `index_M-Event.html` |
| 백엔드 로직 파일 | `functions/index.js` (Firebase Functions 2nd Gen, `asia-northeast3` 리전) |
| Firebase 프로젝트 ID | `m-smart-90148` (M-SMART와 같은 프로젝트를 공유해요) |

---

## 🔁 전체 그림: 누가 이슈를 만들고, 누가 알림을 보내나요?

이게 m-event를 이해하는 데 제일 중요한 부분이에요. **m-event 화면(index_M-Event.html)이 직접 이슈를 만드는 게 아니에요.**

```
1. 직원이 M-SMART 앱에서 점검하면서 "특이사항 메모"를 적음
        ↓
2. Firestore의 inspection_logs 문서에 memo가 저장됨
        ↓
3. Firebase Functions(index.js)가 이 변화를 자동으로 감지! (onDocumentWritten 트리거)
        ↓
4. memo가 있으면 → events 컬렉션에 새 이슈를 자동 생성
        ↓
5. 그 센터 담당 관리자에게 메일 자동 발송 (📩 새 이벤트 발생!)
        ↓
6. m-event 화면(index_M-Event.html)을 열면, Firestore를 실시간 구독해서
   방금 생성된 이슈가 화면에 즉시 나타남
        ↓
7. 관리자가 m-event 화면에서 "조치 진행" 또는 "완료" 버튼 클릭
        ↓
8. Firestore의 events 문서가 업데이트됨
        ↓
9. Functions가 이 변화도 자동 감지 → 상태 변경 메일 발송
        ↓
10. (3일 동안 "완료"로 안 바뀌면) 매일 09:00 자동 점검 → 재알림 메일
```

> 🧸 비유: m-event 화면은 "게시판"이고, Functions(`index.js`)는 "게시판 뒤에서 자동으로 글을 올려주고 알림도 보내주는 로봇 비서"예요. 사람은 그냥 점검 앱에 메모만 적으면, 나머지는 로봇이 알아서 다 해줘요.

---

## 🔐 로그인 방식 (2026-07 개편 — 서버사이드 인증으로 전환됨)

> ⚠️ **구조가 바뀌었어요**: 예전엔 화면(JS)이 Firestore의 `UserDB`를 직접 조회해서 로그인 여부를 판정했는데, 이 방식은 클라이언트가 결과를 조작할 수 있고 "누가/언제/어느 기기에서 시도했는지" 기록이 전혀 안 남는 문제가 있었어요. 특히 A센터 사람이 B센터 관리자의 이름+전화번호를 알아내 로그인해도 막을 수도 추적할 수도 없었어요. 그래서 로그인 판정 자체를 **Firebase Functions(`loginWithCredentials`)로 옮겼어요.**

```
이름 + 전화번호 입력 (화면)
        ↓
Cloud Function(loginWithCredentials) 호출 — 판정은 전부 서버에서
        ↓
UserDB에서 이름이 일치하는 사람을 최대 5명까지 조회
        ↓
그 중 전화번호가 "완전히 일치"해야 통과
        ↓
성공/실패 관계없이 login_attempts 컬렉션에 시도 기록 (이름, 전화번호, IP, 기기정보, 매칭된 센터, 어느 앱에서 시도했는지)
        ↓
5회 연속 실패하면 login_lockouts 문서에 15분 잠금 기록 (이름 단위로 공유 — 어느 앱으로 시도하든 같은 사람 취급)
        ↓
성공 시 Firebase Custom Token 발급 → 화면이 firebase.auth()로 진짜 로그인
```

### 로그인 시도 기록용 컬렉션 2개 (둘 다 정상, 역할이 달라요)

| 컬렉션 | 문서 단위 | 역할 |
|---|---|---|
| `login_attempts` | 시도할 때마다 새 문서 추가 (계속 누적) | 성공/실패/차단 관계없이 모든 시도 이력 기록 |
| `login_lockouts` | **이름 단위로 문서 1개**, 계속 덮어씀 | 5회 실패 시 15분 잠금 상태만 관리 |

### 세션 유지 방식도 바뀌었어요
> ~~로그인에 성공하면 sessionStorage에 사용자 정보를 저장~~ → **이제는 진짜 Firebase Auth 세션을 씁니다.** `auth.onAuthStateChanged`가 새로고침/재방문 시 커스텀 클레임(`name`, `center_name`, `active`)에서 로그인 상태를 자동 복원해요. sessionStorage는 더 이상 안 씀.

### `UserDB` 문서 ID = Firebase Auth UID
`loginWithCredentials`는 매칭된 `UserDB` 문서의 Firestore 문서 ID를 그대로 Auth UID로 써서 커스텀 토큰을 발급해요(`createCustomToken(matched.id, ...)`). 그래서 문서 안에 `uid` 필드를 별도로 저장할 필요가 없고, 최초 로그인 시 uid를 채워 넣는 마이그레이션 절차도 필요 없어요. (단, `UserDB` 문서 ID가 한글/공백 등 Auth UID로 못 쓰는 형식이면 안 됨 — 확인 필요)

### 다중 앱 지원용 `allowed_apps` 필드 (선택적)
같은 `UserDB`/로그인 시스템을 M-Event 외 다른 앱(M-SMART 등)도 같이 씀. `allowed_apps: string[]` 필드가:
- **없으면** → 모든 앱에서 로그인 허용 (하위호환 기본값 — 현재 대부분의 계정이 이 상태일 가능성 높음)
- **있으면(`["m-event"]` 등)** → 그 배열에 있는 앱에서만 허용

> ⚠️ 다만 M-Event와 다른 앱이 서로 다른 도메인이면 한쪽 로그인이 다른 쪽에 자동으로 이어지진 않아요 (Firebase Auth 세션은 브라우저 origin 단위). 완전 자동 SSO를 원하면 별도 연동이 필요해요.

---

## 📑 화면 구성 (탭)

| 탭 이름 | 무엇을 하나요? | 누가 볼 수 있나요? |
|---|---|---|
| 이벤트 탭 | 발생한 이슈 목록 (실시간 갱신), 진행중/완료 구분, 상태 변경 | 모든 사용자 |
| 엑셀 탭 | 생성된 엑셀 점검 보고서 다운로드 | 모든 사용자 |
| 사진 탭 | 점검 시 첨부된 사진 모아보기 | 모든 사용자 |
| 보고서 탭 | (양식 준비 중 — 아직 빈 안내 문구만 있음) | 🔒 관리자만 |

### 🔒 보고서 탭이 보이는 조건
```js
const isAdminOrMaster = currentUser.active === true || currentUser.center_name === "Master";
```
즉 `active: true`(관리자)이거나 `center_name: "Master"`(전체 관리자)인 경우에만 탭이 보여요.

> ⚠️ **현재 상태**: 보고서 탭은 코드상 권한 체크는 다 되어 있는데, 실제 내용은 "양식 준비 중입니다"라는 안내 문구만 있어요. 기능 자체는 아직 미완성이에요.

---

## ⏳ 90일 제한 — 탭마다 적용 방식이 달라요

세 탭 모두 "최근 90일까지만 조회 가능"하다는 규칙은 같지만, **실제로 막는 방식이 서로 달라요.**

| 탭 | 90일 제한 방식 |
|---|---|
| 이벤트 탭 | Firestore 쿼리 자체에 `where("created_at", ">=", 90일전)` 조건이 걸려있어요. 애초에 90일 넘는 데이터는 가져오지도 않아요 |
| 엑셀 탭 | 사용자가 입력한 시작일~종료일의 차이를 JS에서 계산해서, 90일 넘으면 `alert`로 막아요 |
| 사진 탭 | 엑셀 탭과 동일하게 프론트엔드에서 날짜 차이 계산 후 alert |

> ⚠️ **알아둘 점**: 엑셀/사진 탭의 90일 제한은 "쿼리 자체를 막는 것"이 아니라 **화면(JS)에서 미리 확인하고 경고만 띄우는 방식**이에요. 즉 브라우저 개발자도구로 이 체크를 우회하면 90일 넘는 기간도 조회가 가능할 수 있어요. 진짜 강제로 막으려면 서버 쪽(Functions나 Firestore 보안 규칙)에서도 제한을 걸어야 해요.

---

## 🎯 이벤트(이슈) 상태 흐름

| 상태 | 의미 | 색 |
|---|---|---|
| `발생` | 막 생성된 신규 이슈 | 🔴 빨강 |
| `조치중` | 누군가 처리를 시작함 | 🟡 노랑 |
| `완료` | 처리가 끝남 | 🟢 초록 |

각 이슈에는 `history`라는 **타임라인 배열**이 있어서, "누가, 언제, 무슨 내용으로" 상태를 바꿨는지 전부 기록돼요. m-event 화면에서 이슈를 클릭하면 이 타임라인이 시각적으로 보여요.

---

## 📧 자동 이메일 알림 (Firebase Functions)

`index.js`에 정의된 자동 트리거들이에요.

| 함수 이름 | 언제 실행되나요? | 무엇을 하나요? |
|---|---|---|
| `onInspectionLog` | M-SMART에서 점검 기록(`inspection_logs`)이 생성/수정되고 `memo`가 있을 때 | `events`에 새 이슈 생성 + 관리자에게 "새 이벤트 발생" 메일 |
| `onIssueUpdate` | `events` 문서의 `status`가 바뀔 때 | "조치 진행" 또는 "이벤트 완료" 메일 발송 |
| `issueReminderScheduler` | 매일 09:00 (Asia/Seoul) | 3일 넘게 `완료`가 안 된 이슈를 찾아서 재알림 메일 |

### 📬 누가 메일을 받나요?
`getAdminEmails(center_name)`이 `UserDB`에서 `center_name`이 일치하고 `active: true`인 관리자의 `email` 필드를 모아서 발송해요.

### 🔁 중복 이슈 방지
같은 점검 기록(`source_log_id`)으로 이미 이슈가 만들어져 있으면, 새로 만들지 않고 기존 이슈의 메모만 업데이트해요. 같은 점검 건으로 메모를 두 번 고쳐도 이슈가 중복 생성되지 않아요.

> 🧸 비유: 같은 사건에 대해 신고서를 두 번 새로 쓰는 게 아니라, 원래 있던 신고서 내용만 고쳐 쓰는 것과 같아요.

### 메일 발송 실패는 조용히 처리돼요 (중요)
`sendMail()`은 실패해도 throw하지 않고 로그만 남기고 `false`를 반환해요. 즉 **이벤트/이슈 생성 자체는 정상으로 보이는데 메일만 안 오는 상황**이 생길 수 있어요 — 아래 트러블슈팅 섹션 참고.

---

## 🔑 이메일 인증 정보 관리 (Secret Manager 기반)

> ✅ **개선 완료**: 예전엔 `functions.config().gmail.user/pass` 방식(1st Gen)을 썼는데, 지금은 **Secret Manager(`defineSecret`) 기반**으로 완전히 전환됐어요.

```js
const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_PASS = defineSecret("GMAIL_PASS");
function getGmailAuth() {
  return { user: GMAIL_USER.value(), pass: GMAIL_PASS.value() };
}
```

- `GMAIL_USER`: 실제 Gmail 주소 (앱 비밀번호 발급 시 적는 "이름" 라벨이 아님)
- `GMAIL_PASS`: Google 계정에서 발급받은 16자리 앱 비밀번호 (공백 제거)
- 값을 갱신하려면 `firebase functions:secrets:set GMAIL_USER` / `GMAIL_PASS` 사용
- 2nd Gen 함수는 **배포 시점의 시크릿 버전이 함수 리비전에 고정**되므로, 시크릿을 갱신했으면 **반드시 재배포**까지 해야 반영돼요 (시크릿만 바꾸고 재배포 안 하면 예전 값을 계속 참조함)

---

## ⚙️ Cloud Functions 세대(Gen) 및 배포 규칙

> ✅ **해결 완료**: 예전 인수인계 노트에 있던 "`issueReminderScheduler`가 1st Gen이라 Node 22와 호환 안 됨" 이슈와 "`functions.config()` 잔존" 이슈는 모두 해결됐어요. 현재 **모든 함수가 2nd Gen(`firebase-functions/v2`)** 이고, `defineSecret()`으로 시크릿을 관리해요. Node.js 런타임은 22, 리전은 `asia-northeast3`로 통일되어 있어요.

### 배포 시 반드시 지켜야 할 것 — codebase 프리픽스
이 프로젝트의 Functions codebase 이름이 `m-event`로 지정되어 있어서, 배포할 땐 **함수명 앞에 codebase를 붙여야** 해요:
```bash
firebase deploy --only functions:m-event:onInspectionLog,functions:m-event:onIssueUpdate,functions:m-event:issueReminderScheduler
```
codebase 프리픽스를 빼면 배포가 조용히 실패(silent abort)할 수 있어요.

### `firebase deploy --only functions` (전체 배포)는 금지
같은 Firebase 프로젝트에 M-Event와는 무관한 별도 모니터링 함수(`collectMetrics`, `getDashboardData`, `us-central1`)가 같이 있어서, 전체 배포하면 이 함수들이 삭제 시도될 수 있고 M-Event 재배포로는 복구가 안 돼요. 항상 함수명을 명시해서 배포하세요.

---

## 🔗 m-event는 자체 서버가 없어요 (Dashboard에 얹혀가는 구조)

m-event는 **자체 Cloud Run 서버(server.js)가 없어요.**

### 왜 이렇게 됐나요? (히스토리)
원래 m-event는 **자체 `server.js`를 따로 갖고 있었어요.** 그런데 화면에 `기계_01`, `전기_01`, `순찰_02` 같은 설비ID를 그대로 보여주면 사람이 봐서는 그게 어디에 있는 무슨 설비인지 알 수가 없는 문제가 있었어요. 이걸 `OHD1F_1A01` 같은 실제 위치명이나 점검표 이름(시트라벨)으로 바꿔서 보여줘야 했는데, **그 "ID → 사람이 읽는 이름" 매핑 로직이 이미 Dashboard(facility-dashboard)의 server.js에 구현되어 있었어요** (`getFidLocations`, `getSheetLabels` 함수). 그래서 m-event에 똑같은 로직을 중복으로 또 만드는 대신, Dashboard의 API(`/api/fidlocations`)를 가져다 쓰는 쪽으로 리팩토링됐어요.

> 🧸 비유: m-event도 원래는 자기만의 "이름표 변환기"를 갖고 있었는데, 알고 보니 옆집(Dashboard)에 이미 똑같은 변환기가 있어서, 자기 것은 버리고 옆집 것을 빌려 쓰기로 한 거예요.

### 지금 구조
- 로그인 판정은 Cloud Function(`loginWithCredentials`)이, 이벤트 목록 실시간 구독·엑셀/사진 조회는 **여전히 m-event 화면이 Firestore에 직접 접속**해요 (Dashboard를 거치지 않음).
- **설비 이름 표시(`fidLocations`, `sheetLabels`)만 유일하게 Dashboard의 `/api/fidlocations`를 거쳐요.**

```js
const DASHBOARD_API = "https://facility-dashboard-267082158406.asia-northeast3.run.app";
...
fetch(`${DASHBOARD_API}/api/fidlocations?center=...`);
```

> ⚠️ **유지보수 시 알아둘 점**: 이 구조 때문에 m-event와 Dashboard는 **서로 의존 관계**예요. Dashboard의 `/api/fidlocations` 엔드포인트 이름이나 응답 형식을 바꾸면, m-event의 설비 이름 표시 기능이 같이 망가질 수 있어요.

---

## 📆 근무일지 (work_log) — 이벤트 트래커와는 별도의 기능

> m-event는 이벤트/이슈 관리 외에 **센터별 근무일지(일일 근무 기록 + 엑셀 보고서 자동 생성)** 기능도 같이 갖고 있어요. 이벤트 트래커와는 별개의 탭/데이터 흐름이에요.

### 무엇을 하나요?
- 센터 직원이 화면에서 그날의 근무 정보(주간/야간 근무자, 점검사항, 특이사항, 법정점검, 자재 입출고 등)를 입력하면 Firestore에 저장돼요.
- 매일 09:00(Asia/Seoul)에 Functions가 그 전날의 근무일(09:00~다음날 09:00을 하루로 침) 데이터를 모아서, **센터별 원본 엑셀 양식을 그대로 복제한 뒤 값만 채워 넣는 방식**으로 월별 엑셀 파일을 자동 생성해요.

### 데이터 구조
| Firestore 위치 | 역할 |
|---|---|
| `work_logs/{center}_{workday}` | 하루치 근무일지 기본 정보 (문서 1개, 필드 단위로 blur 시 자동저장) |
| `work_logs/{...}/dayWork`, `dayCheck`, `nightWork`, `nightNote`, `legal`, `material` | 여러 명이 동시에 입력해도 안전하게 각자 `add()`로 쌓이는 하위 컬렉션 (줄 단위 항목들) |
| Storage: `templates/{center}/work_log.xlsx` | 센터별 원본 엑셀 양식 (시트 "양식") — 이 템플릿을 복제해서 날짜별 시트로 값을 채움 |
| Storage: `templates/{center}/work_sheet.xlsx` | 출근부 원본 양식 — 출석 코드(주/야/비/휴/교/병/연+휴가/대휴+오) 자동 매핑용 |
| Storage: `work_log/{center}/{연월}_점검표.xlsx` | 최종 생성되는 월별 근무일지 엑셀 결과물 |

### 관련 Functions

| 함수 이름 | 언제 실행되나요? | 무엇을 하나요? |
|---|---|---|
| `workLogDailyExport` | 매일 09:00 (Asia/Seoul) | 방금 끝난 근무일(어제 09:00~오늘 09:00)의 `work_logs` 데이터를 센터별 원본 템플릿에 채워서 월별 엑셀에 날짜 시트로 반영 |
| `workLogDailyInit` | 매일 09:00 (Asia/Seoul) | Storage의 출근부 원본(`work_sheet.xlsx`)을 읽어 컬럼 위치를 동적으로 감지하고, 출석 코드를 그날 `work_logs` 문서에 자동으로 채워 넣음 (단, **문서가 이미 있으면 손대지 않음** — 수기로 입력 중인 내용을 자동화가 덮어쓰지 않도록 하기 위함) |

> 🧸 비유: 매일 아침 9시가 되면 "어제 하루치 출퇴근부는 자동으로 채워주고, 근무일지는 정해진 양식지에 옮겨 적어서 파일로 정리해주는" 사무보조가 돌아가는 셈이에요. 다만 이미 누가 손으로 써놓은 부분은 건드리지 않아요.

### 왜 "템플릿 복제" 방식으로 만들었나요?
예전엔 엑셀 셀 좌표를 코드에 하드코딩(`WORKLOG_LAYOUT`)해서 값을 채웠는데, 센터마다 양식이 조금씩 달라서 유지보수가 힘들었어요. 그래서 **Firebase Storage에 저장된 센터별 원본 양식 파일을 그대로 복제**(스타일/병합/열너비 포함)한 뒤, 정해진 좌표에 값만 써넣는 방식으로 바꿨어요. 라벨이나 병합 구조를 바꾸고 싶으면 Storage의 템플릿 파일, 화면의 근무일지 표 마크업, 코드의 좌표 상수 — 이 셋을 같이 맞춰야 해요.

### 동시 편집 시 데이터 안 날아가게 하는 방식
- 단일 필드(기본정보)는 **필드 하나가 blur(포커스 아웃)될 때마다 그 필드만** Firestore에 저장해요. 예전처럼 "저장" 버튼으로 화면 전체 값을 한 번에 덮어쓰면, 다른 컴퓨터가 아직 입력 안 한 필드까지 빈 값으로 지워버리는 문제가 있었거든요.
- 줄 단위 항목(법정점검/자재입출고 등)은 각자 `add()`로 하위 컬렉션에 쌓이는 방식이라 여러 명이 동시에 써도 서로 덮어쓰지 않아요.

### 화면 쪽 진행 상황
- ✅ 월별 다운로드 패널(1~12월 그리드 + 연도 이동) 추가 및 배포 완료
- 🔜 다운로드 패널을 좌측 사이드바 레이아웃으로 재배치 예정
- 🔜 새 출근부(출근부 탭) 화면 — 내용 미정
- 🔜 TODO: 소프트 삭제, Enter키로 다음 칸 이동, 동시편집 시 렌더링 버그, 행 단위 편집 잠금

### 트러블슈팅 메모
- 출근부/근무일지가 자동으로 안 채워지면 → `firebase functions:log --only workLogDailyInit`(또는 `workLogDailyExport`)로 로그 확인. 템플릿 파일(`templates/{center}/...`)이 Storage에 없으면 그 센터만 조용히 스킵되고 다른 센터는 계속 진행돼요 (에러가 전체를 막지 않는 설계)
- 이미 문서가 있는 날짜는 `workLogDailyInit`이 손대지 않으니, "자동 매핑이 안 됐다"고 착각하기 전에 수기 입력 여부부터 확인

---

## 🛠️ 기술 스택

| 분류 | 내용 |
|---|---|
| 프론트엔드 | 순수 HTML/CSS/JS (프레임워크 없음), 단일 파일 `index_M-Event.html` |
| 백엔드 | Firebase Functions 2nd Gen (Node.js 22, `asia-northeast3`) — 자체 서버 없음, 설비 이름 표시만 Dashboard API에 의존 |
| 인증 | Firebase Auth (Custom Token 발급 방식) + 커스텀 로그인 잠금 로직 |
| 데이터베이스 | Firestore (`events`, `inspection_logs`, `UserDB`, `login_attempts`, `login_lockouts`, `Maxerve_Excel`, `settings/all_centers`, `work_logs`, `center_configs`) |
| 파일 저장소 | Firebase Storage (사진, 근무일지/출근부 템플릿) |
| 메일 발송 | Nodemailer + Gmail SMTP (Secret Manager로 인증정보 관리) |
| 배포 | Firebase Hosting + Functions (GitHub Actions CI/CD) |

---

## ❓ 더 알아야 할 것들 (확인 필요)

- [ ] GitHub 레포 주소 → `jawon0804-bot/m-event`로 확인됨
- [ ] 보고서 탭의 실제 구현 일정 (현재는 "준비 중" 안내만 있음)
- [ ] `UserDB` 문서 ID가 전부 Auth UID로 쓸 수 있는 형식(특수문자/공백 없음)인지 확인 필요
- [ ] `allowed_apps` 필드가 실제 데이터에 얼마나 채워져 있는지 Firestore 콘솔에서 확인 필요 (대부분 미설정=전체허용 상태로 추정)

---

## 🚨 트러블슈팅 / 미래의 나를 위한 메모

> 시스템이 너무 잘 돌아가서 한동안 안 건드리다가, 갑자기 뭔가 안 될 때 여기부터 확인하세요.

### 이슈가 자동으로 안 생겨요
1. M-SMART에서 memo를 적었는데도 안 생기면, Firebase Functions 로그부터 확인 (`firebase functions:log`)
2. `onInspectionLog` 트리거가 켜져 있는지, 배포가 빠진 건 아닌지 확인
3. memo 내용이 이전 값과 똑같으면 트리거가 무시하도록 되어 있음 (`memo === prevMemo`) — 의도된 동작이니 착각하지 말 것

### 상태 변경 메일이 안 와요
1. `onIssueUpdate`는 `status` 필드가 실제로 바뀔 때만 동작함 — 다른 필드만 바꾸면 메일 안 감 (의도된 동작)
2. `UserDB`에서 해당 센터 관리자의 `active: true` 또는 `center_name: "Master"` 여부 확인

### 이벤트는 정상 생성되는데 메일만 안 와요 (2026-07-08 실제 발생 사례)
`sendMail()`은 실패해도 조용히 로그만 남기므로 반드시 로그부터 확인해야 해요.
```bash
firebase functions:log --only onInspectionLog -n 50
```
- `수신자 없음, 메일 발송 스킵` → `UserDB`에서 해당 센터의 `active: true` + `email` 필드 확인
- `메일 발송 실패: ... Invalid login: 535-5.7.8 Username and Password not accepted` → **Gmail 앱 비밀번호 만료.** Google 계정에서 새 앱 비밀번호 재발급 → `firebase functions:secrets:set GMAIL_PASS`로 갱신 → **반드시 재배포**까지 완료해야 반영됨. (시크릿 값 입력은 Windows cmd.exe에서 붙여넣기가 씹히는 경우가 있어 `--data-file` 옵션으로 우회하는 걸 권장)
- 로그 자체가 안 찍힘 → 배포 누락 가능성, `firebase functions:list`로 배포 상태 확인

### 3일 경과 알림이 안 와요 (또는 너무 자주 와요)
- Firestore 복합 인덱스(`status` + `last_notified_at`)가 없으면 쿼리 자체가 조용히 실패할 수 있음 — 콘솔에 뜨는 인덱스 생성 링크로 생성

### 설비 이름이 ID로만 표시돼요 (이름이 안 보여요)
- m-event는 자체 서버가 없고 **Dashboard(facility-dashboard)의 `/api/fidlocations`를 빌려 씀**
- Dashboard 서비스가 죽어있거나, 그 API 경로/응답 형식이 바뀌면 m-event의 이름 표시 기능 전체가 영향받음
- 확인 순서: Dashboard Cloud Run 서비스 상태 → `/api/fidlocations` 응답 형식 → m-event 콘솔 에러 로그

### 로그인이 이상해요 (잠기거나, 다른 센터인데 같이 잠김)
- `login_lockouts`는 **이름 단위로 공유**되는 게 정상 설계예요 — 다른 센터라도 이름이 같으면 같은 잠금 문서를 씀 (의도된 동작)
- 특정 계정이 특정 앱에서만 로그인이 안 되면 `UserDB` 문서의 `allowed_apps` 필드부터 확인

### 왜 이렇게 짰는지 (설계 이유)
- **자체 서버를 안 만든 이유**: 이미 Dashboard가 같은 설비 이름 매핑 데이터를 갖고 있어서, 똑같은 로직을 중복 구현하지 않으려고 빌려 쓰는 구조로 설계함.
- **타임라인(history) 배열을 쓰는 이유**: 단순히 "지금 상태"만 저장하면 "누가 언제 조치했는지" 이력이 사라지므로, 책임 추적과 감사(audit) 목적으로 모든 상태 변경을 배열에 누적함.
- **로그인 판정을 서버(Functions)로 옮긴 이유**: 클라이언트가 결과를 조작할 수 없게 하고, 모든 시도를 IP·기기정보와 함께 기록해서 다른 센터 계정 정보를 이용한 로그인 시도를 추적/차단할 수 있게 하려고.

### 외부 요인으로 멈출 수 있는 지점
- **Gmail 앱 비밀번호 만료** (Google 보안 정책 갱신, 2단계 인증 재설정 등으로 예고 없이 무효화될 수 있음) → 메일 발송 전체 중단. 분기별 점검 습관 권장
- Dashboard 서비스 장애 시 m-event의 설비 이름 표시 기능도 같이 영향받음 (위 의존 관계 참고)

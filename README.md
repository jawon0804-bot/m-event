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
| 엑셀 탭 | 생성된 엑셀 점검 보고서 다운로드 (개별 / 여러 개를 시트별로 합친 **파일 병합**) — 아래 "🧩 엑셀 파일 병합" 섹션 참고 | 모든 사용자 |
| 사진 탭 | 점검 시 첨부된 사진 모아보기 | 모든 사용자 |
| 보고서 탭 | 서브탭 2개: **이벤트**(기간 내 이벤트를 엑셀로 매핑·다운로드) / **점검표**(월별 daily/weekly/monthly 생성 현황 집계) — 아래 "📊 이벤트 보고서", "📈 점검표 현황" 섹션 참고 | 🔒 관리자만 |

### 🔒 보고서 탭이 보이는 조건
```js
const isAdminOrMaster = currentUser.active === true || currentUser.center_name === "Master";
```
즉 `active: true`(관리자)이거나 `center_name: "Master"`(전체 관리자)인 경우에만 탭이 보여요. 서브탭 2개 모두 이 조건 하나로 같이 노출/차단됨(서브탭별 별도 권한 없음).

> ✅ **[2026-07-23] 구현 완료**: 예전엔 권한 체크만 되어 있고 "양식 준비 중입니다"라는 안내 문구뿐이었는데, 지금은 [매핑]/[다운로드] 버튼으로 실제 엑셀 생성·다운로드가 동작해요. 자세한 구조는 아래 "📊 이벤트 보고서" 섹션 참고.

> ✅ **[2026-07-25] 서브탭 분리 + "점검표" 신설**: 기존 이벤트 보고서 화면을 "이벤트" 서브탭으로 옮기고, 근무일지 탭과 같은 서브탭 패턴(`.sub-tabs`/`reportSwitchSubTab()`)으로 "점검표" 서브탭을 새로 추가했어요. M-Engine이 생성하는 점검표(`Maxerve_Excel`)를 월 단위로 몇 번 만들어졌는지 보여주는 화면이에요. 자세한 구조는 아래 "📈 점검표 현황" 섹션 참고.

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

## 🔗 m-event는 자체 서버가 없어요 (그래도 Dashboard에 의존하지는 않아요)

m-event는 **자체 Cloud Run 서버(server.js)가 없어요.** 화면이 Firestore를 직접 읽고, 무거운 작업(엑셀 생성·메일·로그인 판정)만 Cloud Functions가 맡는 구조예요.

### 히스토리 — Dashboard API를 빌려 쓰던 시절과 그 종료
화면에 `기계_01`, `전기_01` 같은 설비ID를 그대로 보여주면 그게 어디의 무슨 설비인지 알 수가 없어서, `OHD1F_1A01` 같은 위치명이나 점검표 이름(시트라벨)으로 바꿔 보여줘야 했어요. 그 "ID → 사람이 읽는 이름" 매핑 로직이 이미 Dashboard의 `server.js`에 있었기 때문에(`getFidLocations`, `getSheetLabels`), 중복 구현 대신 **Dashboard의 `/api/fidlocations`를 호출해서 쓰던 시기가 있었어요.**

> ✅ **[2026-07-11] 이 의존은 없어졌어요.** `firestore.rules`가 `center_configs/{center}/**`를 로그인 사용자 본인 센터(또는 Master)에 한해 직접 읽도록 이미 허용하고 있어서, **m-event가 Firestore를 직접 읽는 방식으로 전환**했어요 (`manager/js/auth.js`의 `loadFidLocations`). Dashboard가 죽어 있어도 m-event 설비명 표시는 멀쩡해요.

### 지금 구조 (Dashboard 호출 0건)
- **설비 이름 매핑**: `center_configs/{center}/facilities`(→`fid_name`)와 `center_configs/{center}/inspections`(→`sheet_label`)를 **직접 조회**. 우선순위는 `sheet_label` > `fid_name` > 설비ID.
- **이벤트 목록/엑셀/사진**: 화면이 Firestore에 직접 접속 (원래부터 Dashboard를 안 거침).
- **로그인 판정**: 자체 Cloud Function `loginWithCredentials`.
- 즉 **m-event → Dashboard 방향의 런타임 의존은 전혀 없어요.** 반대 방향(Dashboard → m-event의 `loginWithCredentials`)만 남아 있어요.

> ⚠️ **[2026-07-29 문서 정정]** 이 절엔 07-11 이후로도 계속 "설비 이름 표시만 유일하게 Dashboard의 `/api/fidlocations`를 거쳐요"라는 설명과 `const DASHBOARD_API = ...; fetch(...)` 코드 예제가 남아 있었어요. **그 코드는 저장소 어디에도 존재하지 않았어요.** 리팩토링 커밋이 코드만 바꾸고 README·`system_map.md`·Dashboard 쪽 문서를 갱신하지 않아서 생긴 오차예요.
>
> 이 오차가 실제로 비용을 만들었어요 — Dashboard 쪽에서는 "m-event가 쓰니까 무인증을 유지해야 한다"는 전제로 그 엔드포인트를 계속 열어뒀고, 07-27엔 그 전제 위에서 방어 로직까지 추가했어요. 소비자가 이미 없다는 걸 확인한 07-29에 **인증 필수로 전환**했습니다.
>
> 🧭 교훈: 저장소 간 의존을 **끊는** 변경은 만드는 변경보다 문서 갱신을 잊기 쉬워요(당장 아무것도 안 깨지니까). 의존을 제거하면 `system_map.md`의 1·3·4번 항목을 반드시 같이 고치세요.

---

## 📊 이벤트 보고서 (report) — 보고서 탭의 엑셀 내보내기 기능

> `events` 컬렉션의 발생/조치/완료 이력을 센터 단위로 모아서 엑셀(EVENT LIST 양식)로 매핑·다운로드하는 기능이에요. 근무일지처럼 "Storage에 저장된 원본 양식을 그대로 복제해서 값만 채우는" 방식을 그대로 재사용했어요.

### 무엇을 하나요?
- 보고서 탭에서 센터/상태/기간(최대 1년)을 골라 **[매핑]**을 누르면, 최신순으로 최대 100건을 골라 엑셀에 채워서 Storage에 저장해요.
- **[다운로드]**를 누르면 그 센터에 이미 매핑돼 있는 파일 목록(수동 매핑분 + 자동 생성분)을 보여주고, 골라서 받을 수 있어요.
- 매달 1일 00:00(Asia/Seoul)에는 필터 없이 **전월 전체**를 센터별로 자동 매핑해서 같은 위치에 쌓아줘요.

### 데이터 구조
| Storage 위치 | 역할 |
|---|---|
| `templates/report/event.xlsx` | 이벤트 보고서 원본 양식 (시트 "양식") — **센터 공용 1개**, 모든 센터가 이 템플릿 하나를 같이 씀 (근무일지 템플릿과 달리 센터별로 안 나뉨) |
| `report/{center}/{start}~{end}_매핑.xlsx` | 보고서 탭에서 수동으로 [매핑]한 결과물 |
| `report/{center}/{연도}년_{월}월_이벤트보고서.xlsx` | 매달 1일 자동 생성되는 전월 보고서 |

### 양식 구조 (매핑 좌표)
- **A1:K4(병합)**: 제목 — 코드가 매번 `"{시작일} ~ {종료일} {센터명}센터 시설설비 EVENT LIST"` 형태로 채움 (시작/종료가 같은 해면 종료일 쪽 "년" 생략, 해가 걸치면 양쪽 다 표기)
- **5행**: 헤더(번호/센터명/발생일시/설비 위치/점검자/사진1~3/상황발생 내용/진행현황/상태) — 라벨은 템플릿에 고정, 코드가 새로 안 씀
- **6~105행**: 데이터 100행 — A열에 1~100 번호가 미리 채워져 있고, 최신순으로 정렬된 이벤트를 위에서부터 채움. 사진은 셀 값이 아니라 F/G/H 각 셀에 4.5×4.5cm 이미지로 직접 삽입돼요. 상태(K열)는 발생=빨강/조치중=파랑/완료=초록으로 색이 자동으로 바뀌어요.
- **106행**: 100건 초과 시에만 쓰이는 안내 행 — "최신 100건만 표시됨, 초과 N건은 기간을 좁혀 다시 조회" 문구가 들어가고, 100건 이하면 이 행 자체를 지워버려요.
- 안 쓰는 데이터 행(예: 매핑된 이벤트가 10건이면 11~105행)은 매핑 후 통째로 삭제해서 빈 줄이 남지 않아요.

### 관련 Functions (`functions/lib/report-export.js`)

| 함수 이름 | 타입 | 언제/어떻게 실행되나요? |
|---|---|---|
| `generateEventReport` | Callable | 보고서 탭 [매핑] 버튼 → 필터(센터/상태/기간) 받아서 즉시 생성. 센터 미지정("전체") + Master면 전체 센터 순회 |
| `listEventReportFiles` | Callable | 보고서 탭 [다운로드] 버튼 → `report/{center}/` 목록 + 서명URL(10분 유효) 반환 |
| `eventReportMonthlyExport` | Scheduled (매달 1일 00:00 Asia/Seoul) | 필터 없이 전월 전체를 센터별로 자동 매핑 |

> ⚠️ 다른 함수들처럼 배포 시 codebase 프리픽스 필요: `firebase deploy --only functions:m-event:generateEventReport,functions:m-event:eventReportMonthlyExport,functions:m-event:listEventReportFiles`

---

## 🧩 엑셀 파일 병합 (엑셀 탭 [파일 병합])

엑셀 탭 목록에서 점검표를 체크하고 [파일 병합]을 누르면, 고른 파일들이 **시트 하나씩으로 들어간 엑셀 1개**로 합쳐져서 내려받아져요. M-Engine이 만드는 점검표는 파일당 시트가 정확히 1개라(`M-Engine/excel_writer.py`가 저장 직전에 나머지 시트를 제거함) "파일 N개 → 시트 N개"로 1:1 대응돼요.

- **선택 방식**: 행마다 체크박스, 맨 위 [전체 선택]은 **현재 페이지(30건)가 아니라 조회 결과 전체**가 대상이에요(라벨에 전체 건수를 같이 표시). 페이지를 넘겨도 선택은 유지되고, [조회]를 다시 누르면 초기화돼요.
- **시트 이름**: `MM-DD_라벨` (예: `07-24_정보통신`). 라벨은 화면 목록 제목과 같은 규칙(`sheet_label` > `fid_name` > 설비ID). 엑셀 제약에 맞춰 31자로 자르고, 겹치면 `_2`, `_3`을 붙여요.
- **시트 순서**: 화면 목록에 보이던 순서(최신순) 그대로예요.
- **상한**: 한 번에 100건. 넘으면 프런트/서버 양쪽에서 막아요.
- **저장 위치**: `excel_merge/{center}/{센터}_{시작}~{종료}_병합.xlsx` — 파일명이 (센터, 기간)으로 고정이라 같은 조건으로 다시 누르면 덮어쓰기 되고 Storage에 무한정 쌓이지 않아요. 보고서 탭이 나열하는 `report/{center}/`와는 일부러 분리했어요(섞이면 보고서 파일 목록에 같이 보임).

### 왜 서버에서 합치나요?
관리자 페이지엔 이미 SheetJS가 로드돼 있어서 브라우저에서도 합칠 수 있지만, **무료판은 읽어들인 서식을 다시 쓰지 못해요** — 테두리/색/글꼴/로고가 전부 날아가고 값만 남은 격자가 돼요. 점검표는 인쇄해서 제출하는 문서라 그건 못 써서, 서식을 보존하는 ExcelJS(서버)로 합쳐요.

### ⚠️ ExcelJS가 openpyxl 파일을 못 읽는 문제 (해결됨)
M-Engine은 openpyxl로 파일을 만드는데, openpyxl은 그림(drawing) XML을 기본 네임스페이스(`<wsDr xmlns=...>`)로 쓰는 반면 ExcelJS 파서는 `xdr:` 접두사가 붙은 태그만 인식해요. 그래서 **센터 템플릿에 로고가 하나라도 박혀 있으면 그 센터 점검표는 로드 자체가 실패**했어요(`Cannot read properties of undefined (reading 'anchors')`).

`functions/lib/excel-utils.js`의 `loadWorkbookTolerant()`가 3단계로 처리해요:
1. 원본 그대로 로드 시도
2. 실패하면 drawing XML에 `xdr:` 접두사를 붙여 정규화 후 재시도 (→ **이미지까지 살아서 넘어감**)
3. 그래도 안 되면 그림 파트를 들어내고 로드 (로고는 잃지만 서식/데이터는 보존 — 기능이 통째로 죽는 것보다 낫다는 판단). 이 경우 응답의 `strippedImages`에 집계돼서 화면에 안내돼요.

### 관련 Functions (`functions/lib/excel-merge.js`)

| 함수 이름 | 타입 | 언제/어떻게 실행되나요? |
|---|---|---|
| `mergeExcelFiles` | Callable | 엑셀 탭 [파일 병합] 버튼 → 선택한 **문서 ID 목록**을 받아 병합, 서명URL(10분) 반환 |

> ⚠️ 배포 시 codebase 프리픽스 필요: `firebase deploy --only functions:m-event:mergeExcelFiles`

**보안**: 클라이언트가 Storage 경로를 보내는 게 아니라 **문서 ID만** 보내요. 서버가 그 ID로 Firestore를 직접 읽고 각 문서의 `center_name`이 요청 센터와 같은지 다시 대조해서, 남의 센터 문서 ID를 섞어 보내도 그 문서는 조용히 빠져요(`missing`으로 보고). 문서 ID 직접 조회(`getAll`)만 쓰므로 **새 복합 색인이 필요 없어요**.

**공통 유틸**: 워크북 간 시트 복제(`cloneSheet`)와 ExcelJS의 `<sheetPr>` 순서 버그 우회(`fixSheetPrOrder`)는 `functions/lib/excel-utils.js`로 모아서 근무일지·이벤트 보고서·파일 병합 셋이 같이 써요. `fixSheetPrOrder`는 예전에 `sheet1.xml` 하나만 고쳤는데, 시트가 여러 개인 병합본에선 나머지가 안 고쳐져서 워크시트 전체를 도는 버전으로 일반화했어요.

---

### 왜 다운로드 링크를 매번 새로 발급하나요?
`listEventReportFiles`가 반환하는 다운로드 URL은 10분짜리 서명 URL이에요 — 파일 자체는 Storage에 계속 남아있고, [다운로드] 버튼을 다시 누르면 그때마다 새 링크가 발급돼요. 링크 유효기간을 짧게 잡은 건 비용 때문이 아니라(서명 URL 발급 자체는 무료) **유출된 링크가 오래 살아있지 않게 하려는 보안 목적**이에요.

### Dashboard(facility-dashboard) 연동
[2026-07-23] Dashboard의 3번 뷰(피봇 테이블) "이벤트 보고서" 팝업도 이 Storage 경로(`report/{center}/`)를 그대로 읽어서 보여주도록 바뀌었어요 — 원래 Dashboard가 보여주던 설비별 점검표(`Maxerve_Excel`)는 대체됐어요. 자세한 내용은 Dashboard 레포의 README "🕰️ 변경 이력" 참고.

### 트러블슈팅 메모
- [매핑]을 눌렀는데 아무 파일도 안 생기면 → 그 센터/기간/상태 조합으로 조회된 `events`가 0건이면 조용히 스킵돼요(정상 동작). Functions 로그(`firebase functions:log --only generateEventReport`)에서 `skipped` 결과 확인
- `center_name` + `status` + `created_at` 범위를 같이 거는 쿼리라 Firestore 복합 색인이 필요할 수 있어요 — 처음 실행 시 에러 메시지에 색인 생성 링크가 자동으로 찍혀요
- 템플릿(`templates/report/event.xlsx`)이 Storage에서 지워지거나 시트명("양식")이 바뀌면 매핑 자체가 실패해요 — 양식을 고칠 땐 셀 구조(6~105행 데이터, 106행 안내)를 유지해야 코드 좌표와 안 어긋나요

---

## 📈 점검표 현황 (2026-07-25 추가, 2026-07-26 재설계) — 보고서 탭의 "점검표" 서브탭

> M-Engine이 자동/수동으로 생성한 점검표(`Maxerve_Excel` 컬렉션)를 센터+월 단위로 "기대 횟수 대비 실제 횟수"로 집계해서 보여주는 화면. M-Engine의 월간 요약 메일(`/monthly_report`, M-Engine 레포 README "2026-07-26" 항목 참고)과 **완전히 동일한 계산 결과**를 화면에서도 바로 보여주는 게 목표. 서버(Functions/Cloud Function) 없이 클라이언트에서 Firestore를 직접 읽어서 그 자리에서 집계함.

### 무엇을 하나요?
- 센터 + 월(`YYYY-MM`)을 고르고 **[조회]**를 누르면, `center_configs/{center}/inspections`(그 센터에 등록된 점검표 전체 목록)을 기준으로 각 점검표의 "기대 횟수"를 계산하고, `Maxerve_Excel`에서 `facility_id`가 일치하는 문서 수를 세서 "실제 횟수"를 매칭함.
- 표 컬럼: 구분(daily/weekly/monthly) · 설비명(sheet_label) · 기대 · 실제 · 상태(정상/⚠️ 부족)
- **실제 생성 건수가 0건인 점검표도 목록에 그대로 나오고 "부족"으로 표시됨** — 월간 요약 메일과 동일하게, "아예 안 만들어진 것"과 "일부만 만들어진 것"을 구분 안 하고 전부 보여줌.

### 🔄 2026-07-26 재설계: 왜 바꿨나
- **처음 버전(2026-07-25)**: `Maxerve_Excel`만 스캔해서 그 안에 있는 `schedule_type`/`sheet_label` 필드로 그룹핑했음. 이 방식의 문제 두 가지가 실사용 중 발견됨:
  1. 특정 달에 **실제 생성된 문서가 하나도 없으면** 표 자체가 통째로 비어서, "몇 건이 부족한지"를 전혀 알 수 없었음(월간 요약 메일은 매번 정상적으로 "부족 14건"처럼 보여주는데 화면은 그냥 텅 빔 — 사용자가 이 불일치를 직접 발견함).
  2. `schedule_type`/`sheet_label` 필드가 **2026-07-25 이후 생성 문서에만 있어서**, 그 이전 문서는 집계에서 통째로 제외됐음.
- **바뀐 방식**: `Maxerve_Excel`만 보는 대신 `center_configs/{center}/inspections`(점검표 설정 전체)를 먼저 읽어서 "이 센터엔 원래 이런 점검표들이 있다"는 전체 목록을 만들고, 각 점검표의 `facility_id`로 `Maxerve_Excel`을 매칭해 실제 개수를 셈. `facility_id`는 2026-07-25 이전 문서에도 항상 있던 필드라서, **옛날 문서도 자동으로 집계에 포함**되고(백필 불필요), 실제 문서가 0건이어도 점검표 자체는 목록에 나오니 월간 메일과 정확히 같은 결과가 나옴.
- `calcExpectedCount()`(`manager/js/report-tab.js`)는 M-Engine `lib/scheduler.py`의 `calc_expected_count()`와 동일한 로직(daily=그 달 일수, monthly=1, weekly=그 달 월요일 수)을 JS로 재구현한 것 — 계산 로직 자체가 단순해서 두 언어에 따로 구현해도 어긋날 위험은 낮다고 보고 이렇게 감(M-Engine에 API를 새로 만들어 호출하는 대신).
- 🆕 **센터명 라벨 추가**: 근무일지 탭의 `wl-center-label`과 동일한 패턴으로, 서브탭(이벤트/점검표) 앞에 로그인한 센터명을 보여주는 라벨(`report-center-label`)을 추가했어요. Master는 "📊 전체 센터", 그 외에는 "📊 {센터명}"으로 표시(`buildCenterFilters()`에서 설정).

### 데이터 출처
- `center_configs/{center}/inspections`: 점검표 목록(schedule_type, sheet_label, fids, active) — "기대 횟수" 계산 기준
- `Maxerve_Excel`: `center_name` + `datetime` 범위로 조회 후 `facility_id`별로 개수 집계 — "실제 횟수"
- `schedule_type`/`sheet_label` 필드(M-Engine이 2026-07-25부터 `Maxerve_Excel`에 같이 저장)는 **이 화면에서는 더 이상 안 씀** — `facility_id` 매칭만으로 충분해서 예전 문서 호환을 위해 남겨둔 셈. (m-event 자체 다른 화면에서 쓸 수도 있으니 필드 자체는 계속 유지)

### 관련 파일
| 파일 | 역할 |
|---|---|
| `manager/js/report-tab.js` | `reportSwitchSubTab()`(서브탭 전환), `loadInspectionReport()`(조회+집계+렌더), `calcExpectedCount()`(기대 횟수 계산) |
| `manager/js/auth.js` | `buildCenterFilters()`의 대상 목록에 `report-insp` 추가 → `filter-center-report-insp` 셀렉트 및 `report-center-label` 채움 |

### 트러블슈팅 메모
- 조회했는데 "이 센터에 등록된 점검표가 없습니다"가 나오면 → `center_configs/{center}/inspections` 자체가 비어있는 것(설정 문제, Firestore 콘솔에서 확인)
- 전부 "부족"으로만 나와도 정상일 수 있음 — 그 달에 실제로 자동 생성이 안 됐으면(예: 스케줄러 버그가 있었던 달) 월간 메일과 동일하게 전부 부족으로 나오는 게 맞는 결과임
- `center_name` + `datetime` 범위 쿼리라 Firestore 복합 색인이 필요할 수 있어요 — 엑셀 탭이 쓰는 것과 같은 컬렉션/필드 패턴이라 이미 색인이 있을 가능성이 높지만, 처음 실행 시 에러가 나면 에러 메시지의 색인 생성 링크를 따라가면 돼요

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
| 파일 저장소 | Firebase Storage (사진, 근무일지/출근부 템플릿, 이벤트 보고서 템플릿/결과물) |
| 메일 발송 | Nodemailer + Gmail SMTP (Secret Manager로 인증정보 관리) |
| 배포 | Firebase Hosting + Functions (GitHub Actions CI/CD) |

---

## ❓ 더 알아야 할 것들 (확인 필요)

- [ ] GitHub 레포 주소 → `jawon0804-bot/m-event`로 확인됨
- [x] 보고서 탭 구현 완료 (2026-07-23, "📊 이벤트 보고서" 섹션 참고)
- [x] 보고서 탭에 "점검표" 서브탭 추가 완료 (2026-07-25, "📈 점검표 현황" 섹션 참고)
- [ ] 이벤트 보고서(`report/{center}/`) 파일이 계속 쌓이기만 하는데, 오래된 파일 정리(수명주기) 정책이 필요한지
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

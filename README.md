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
| 화면 파일 | `index.html` |
| 백엔드 로직 파일 | `index.js` (Firebase Functions, `asia-northeast3` 리전) |
| Firebase 프로젝트 ID | `m-smart-90148` (M-SMART와 같은 프로젝트를 공유해요) |

---

## 🔁 전체 그림: 누가 이슈를 만들고, 누가 알림을 보내나요?

이게 m-event를 이해하는 데 제일 중요한 부분이에요. **m-event 화면(index.html)이 직접 이슈를 만드는 게 아니에요.**

```
1. 직원이 M-SMART 앱에서 점검하면서 "특이사항 메모"를 적음
        ↓
2. Firestore의 inspection_logs 문서에 memo가 저장됨
        ↓
3. Firebase Functions(index.js)가 이 변화를 자동으로 감지! (onWrite 트리거)
        ↓
4. memo가 있으면 → events 컬렉션에 새 이슈를 자동 생성
        ↓
5. 그 센터 담당 관리자에게 메일 자동 발송 (📩 새 이벤트 발생!)
        ↓
6. m-event 화면(index.html)을 열면, Firestore를 실시간 구독해서
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

## 🔐 로그인 방식

m-event는 자체 서버를 거치지 않고, **화면(index.html)에서 직접 Firestore의 `UserDB`를 조회**해요.

```
이름 + 전화번호 입력
        ↓
UserDB에서 이름이 일치하는 사람을 최대 5명까지 조회
        ↓
그 중 전화번호가 "완전히 일치"해야 통과 (수정 완료)
```

> ✅ **수정 완료**: 원래는 전화번호가 "완전 일치" 또는 "뒤 4자리만 일치"해도 로그인이 통과되도록 되어 있었어요. 이건 마스터(관리자) 계정을 짧은 번호(예: `1234`)로 간편하게 등록해서 쓰려던 의도였는데, 문제는 이 느슨한 규칙이 마스터 계정뿐 아니라 **모든 일반 직원 계정에도 똑같이 적용**됐다는 거예요. 같은 끝 4자리를 가진 다른 직원의 번호로도 로그인이 가능했던 보안 허점이었어요. 지금은 `|| p.endsWith(phone.slice(-4))` 부분을 제거해서 완전 일치만 허용하도록 고쳤어요. 마스터 계정(`1234` 같은 짧은 번호)은 DB값과 입력값이 정확히 일치하기만 하면 그대로 로그인되니 영향 없어요.

로그인에 성공하면 `sessionStorage`(브라우저 닫으면 사라지는 저장소, localStorage와 다름)에 사용자 정보를 저장해서, 새로고침해도 로그인이 유지돼요.

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

`index.js`에 정의된 3개의 자동 트리거가 있어요.

| 함수 이름 | 언제 실행되나요? | 무엇을 하나요? |
|---|---|---|
| `onInspectionLog` | M-SMART에서 점검 기록(`inspection_logs`)이 생성/수정되고 `memo`가 있을 때 | `events`에 새 이슈 생성 + 관리자에게 "새 이벤트 발생" 메일 |
| `onIssueUpdate` | `events` 문서의 `status`가 바뀔 때 | "조치 진행" 또는 "이벤트 완료" 메일 발송 |
| `issueReminderScheduler` | 매일 09:00 (Asia/Seoul) | 3일 넘게 `완료`가 안 된 이슈를 찾아서 재알림 메일 |

### 📬 누가 메일을 받나요?
```js
center_name: "in" [해당 센터명]
```
그 센터 소속 관리자(`active: true`)가 메일을 받아요.

### 🔁 중복 이슈 방지
같은 점검 기록(`source_log_id`)으로 이미 이슈가 만들어져 있으면, 새로 만들지 않고 기존 이슈의 메모만 업데이트해요. 같은 점검 건으로 메모를 두 번 고쳐도 이슈가 중복 생성되지 않아요.

> 🧸 비유: 같은 사건에 대해 신고서를 두 번 새로 쓰는 게 아니라, 원래 있던 신고서 내용만 고쳐 쓰는 것과 같아요.

---

## ⚠️ 진행 중인 이슈 (2025-06-30 기준)

### 1) `issueReminderScheduler`가 1st Gen 함수예요
이 스케줄 함수는 옛날 방식(1st Gen Cloud Functions)으로 만들어져 있어서 Node.js 22와 호환되지 않아요. 삭제 후 2nd Gen으로 재배포가 필요해요.
```bash
firebase functions:delete issueReminderScheduler --region asia-northeast3
firebase deploy --only functions:issueReminderScheduler
```

### 2) `functions.config()`가 아직 그대로 남아있어요
```js
auth: {
  user: functions.config().gmail.user,
  pass: functions.config().gmail.pass,
}
```
인수인계 노트에는 "params로 마이그레이션 진행 중"이라고 되어 있는데, `index.js` 안에는 옛날 방식이 그대로예요. 다른 파일은 마이그레이션이 끝났는데 이 파일만 누락된 건지 확인이 필요해요.

### 3) Firestore 복합 인덱스가 필요할 수 있어요
`issueReminderScheduler`에서 아래처럼 부등호 조건이 서로 다른 필드에 걸쳐 있어요:
```js
.where("status", "!=", "완료")
.where("last_notified_at", "<=", threshold)
```
Firestore는 이런 조합에 복합 인덱스가 필요한 경우가 많아요. 인수인계 노트의 "복합 인덱스 추가" 항목이 `inspection_logs`뿐 아니라 **`events` 컬렉션에도 필요할 가능성**이 있어요.

---

## 🛠️ 기술 스택

## 🔗 m-event는 자체 서버가 없어요 (Dashboard에 얹혀가는 구조)

m-event는 **자체 Cloud Run 서버(server.js)가 없어요. 확인 결과, 삭제해도 되는 게 맞아요.**

### 왜 이렇게 됐나요? (히스토리)
원래 m-event는 **자체 `server.js`를 따로 갖고 있었어요.** 그런데 화면에 `기계_01`, `전기_01`, `순찰_02` 같은 설비ID를 그대로 보여주면 사람이 봐서는 그게 어디에 있는 무슨 설비인지 알 수가 없는 문제가 있었어요. 이걸 `OHD1F_1A01` 같은 실제 위치명이나 점검표 이름(시트라벨)으로 바꿔서 보여줘야 했는데, **그 "ID → 사람이 읽는 이름" 매핑 로직이 이미 Dashboard(facility-dashboard)의 server.js에 구현되어 있었어요** (`getFidLocations`, `getSheetLabels` 함수). 그래서 m-event에 똑같은 로직을 중복으로 또 만드는 대신, Dashboard의 API(`/api/fidlocations`)를 가져다 쓰는 쪽으로 리팩토링됐어요. 그 결과 m-event 전용이던 `server.js`는 더 이상 쓸 일이 없어져서 삭제 대상이 된 거예요.

> 🧸 비유: m-event도 원래는 자기만의 "이름표 변환기"를 갖고 있었는데, 알고 보니 옆집(Dashboard)에 이미 똑같은 변환기가 있어서, 자기 것은 버리고 옆집 것을 빌려 쓰기로 한 거예요.

### 지금 구조
- 로그인, 이벤트 목록 실시간 구독, 엑셀/사진 조회는 **여전히 m-event가 Firestore에 직접 접속**해요 (Dashboard를 거치지 않음).
- **설비 이름 표시(`fidLocations`, `sheetLabels`)만 유일하게 Dashboard의 `/api/fidlocations`를 거쳐요.**

자동화(이슈 생성, 메일 발송)는 전부 Firebase Functions(`index.js`)가 별도로 처리해요.

```js
const DASHBOARD_API = "https://facility-dashboard-267082158406.asia-northeast3.run.app";
...
fetch(`${DASHBOARD_API}/api/fidlocations?center=...`);
```

Dashboard의 `server.js` 코드에도 이 사실이 주석으로 명시되어 있어요:
```js
// ── /api/fidlocations ──────────────────────────────────────────
// fid → fid_name 매핑 반환 (m-event 이벤트트래커에서 사용)
```

> ⚠️ **유지보수 시 알아둘 점**: 이 구조 때문에 m-event와 Dashboard는 **서로 의존 관계**예요. Dashboard의 `/api/fidlocations` 엔드포인트 이름이나 응답 형식을 바꾸면, m-event의 설비 이름 표시 기능이 같이 망가질 수 있어요. 두 서비스를 별개로 생각하고 한쪽만 고치면 안 돼요.

---

## 🛠️ 기술 스택

| 분류 | 내용 |
|---|---|
| 프론트엔드 | 순수 HTML/CSS/JS (프레임워크 없음) |
| 백엔드 | Firebase Functions (Node.js) — 자체 서버 없음, Dashboard API에 의존 |
| 데이터베이스 | Firestore (`events`, `inspection_logs`, `UserDB`, `Maxerve_Excel`, `settings/all_centers`) |
| 파일 저장소 | Firebase Storage (사진) |
| 메일 발송 | Nodemailer + Gmail SMTP |
| 배포 | Firebase Hosting + Functions |

---

## ❓ 더 알아야 할 것들 (확인 필요)

- [ ] GitHub 레포 주소
- [ ] 보고서 탭의 실제 구현 일정 (현재는 "준비 중" 안내만 있음)

> 위 항목은 정보를 알려주시면 채워 넣을게요!

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

### 3일 경과 알림이 안 와요 (또는 너무 자주 와요)
- `issueReminderScheduler`가 1st Gen Cloud Functions라서 Node.js 22 환경에서 동작 안 할 수 있음 — 재배포 여부부터 확인 (인수인계 노트 참고)
- Firestore 복합 인덱스(`status` + `last_notified_at`)가 없으면 쿼리 자체가 조용히 실패할 수 있음

### 설비 이름이 ID로만 표시돼요 (이름이 안 보여요)
- m-event는 자체 서버가 없고 **Dashboard(facility-dashboard)의 `/api/fidlocations`를 빌려 씀**
- Dashboard 서비스가 죽어있거나, 그 API 경로/응답 형식이 바뀌면 m-event의 이름 표시 기능 전체가 영향받음
- 확인 순서: Dashboard Cloud Run 서비스 상태 → `/api/fidlocations` 응답 형식 → m-event 콘솔 에러 로그

### 왜 이렇게 짰는지 (설계 이유)
- **자체 서버를 안 만든 이유**: 이미 Dashboard가 같은 설비 이름 매핑 데이터를 갖고 있어서, 똑같은 로직을 중복 구현하지 않으려고 빌려 쓰는 구조로 설계함. (m-event server.js는 삭제 확정됨)
- **타임라인(history) 배열을 쓰는 이유**: 단순히 "지금 상태"만 저장하면 "누가 언제 조치했는지" 이력이 사라지므로, 책임 추적과 감사(audit) 목적으로 모든 상태 변경을 배열에 누적함.

### 외부 요인으로 멈출 수 있는 지점
- Gmail SMTP 인증 정보 만료 (`functions.config().gmail`) → 메일 발송 전체 중단
- Dashboard 서비스 장애 시 m-event의 설비 이름 표시 기능도 같이 영향받음 (위 의존 관계 참고)

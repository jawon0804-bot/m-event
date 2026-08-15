// tests/storage-rules.test.js
// storage.rules를 Firebase Rules API(TestRuleset)로 "실제 규칙 엔진에" 돌려서 검증한다.
//
// 실행:
//   node tests/storage-rules.test.js        (gcloud 로그인 필요, 실패 시 종료 코드 1)
//
// [왜 이 테스트가 있는가]
// 1) 2026-07-29에 라이브 규칙이 `match /{allPaths=**} { allow read, write: if true; }`인
//    상태로 발견됐다. 버킷 전체가 인증 없이 읽기/쓰기 가능했고, 규칙이 버전 관리 밖이라
//    코드 리뷰에도 07-11 보안 감사에도 걸리지 않았다.
// 2) 그걸 고치면서 곧바로 두 번째 함정을 밟았다 —
//       allow read, write: if ownsCenter(center);
//       allow delete: if false;          // ❌ 아무 효과 없음
//    Storage 규칙의 allow 문은 **OR로 결합**되고 `write`가 create/update/**delete**를
//    전부 포함하므로, 뒤에 붙인 `delete: if false`는 앞 문장을 되돌리지 못한다.
//    Firestore 규칙과 달리 허용을 취소하는 deny가 없다.
//    → 삭제를 막으려면 `write` 대신 `create, update`로 나열해야 한다.
//
// 두 번 다 "규칙 문장을 읽고 맞다고 판단"해서 놓친 것이라, 판단 대신 엔진에 물어본다.
// 규칙을 고칠 때마다 이 파일을 돌릴 것.
//
// ⚠️ CI에서는 돌지 않는다(GCP 자격증명 필요). 로컬에서 `firebase deploy --only storage`
//    전에 수동으로 실행하는 용도다.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT = "m-smart-90148";
const BUCKET = `${PROJECT}.firebasestorage.app`;
const RULES_PATH = path.join(__dirname, "..", "storage.rules");

const CENTER = "쿠팡울산2Sub-Hub";
const OTHER = "다른센터";

// loginWithCredentials가 커스텀 토큰에 심는 클레임 형태 그대로.
//
// ⚠️ [2026-08-04 갱신] 아래 셋은 **role이 없는 옛 토큰**이다 — 권한 축을 role로 분리하기
//   전의 형태다. 2026-08-01~08-02에는 폴백이 있어서 `active:true`면 관리자로 통했지만,
//   폴백을 제거한 지금은 **관리자 기능이 전부 막혀야 정상**이다(사진 업로드처럼
//   ownsCenter만 보는 경로는 그대로 동작한다 — 현장은 안 멈춘다).
//   클레임은 재로그인 전까지 갱신되지 않으므로, 폴백 제거 배포 전에 기존 관리자
//   토큰을 폐기해 재로그인시켰다.
const worker = { uid: "u1", token: { center_name: CENTER, active: false } }; // 현장 직원(옛 토큰)
const admin_ = { uid: "u2", token: { center_name: CENTER, active: true } };  // 옛 관리자 토큰(role 없음)
const master = { uid: "u3", token: { center_name: "Master", active: true } };

// 백필(구글시트에 role 열 추가 → syncUsersToFirebase) 이후에 발급될 토큰들.
// 백필하면 로그인이 필요한 전원이 active:true가 되므로, **active만으로는 더 이상
// 관리자를 구분할 수 없다** — 그때 role이 실제로 구분해 주는지가 아래 케이스의 핵심이다.
const workerRole = { uid: "u4", token: { center_name: CENTER, role: "user", active: true } };
const adminRole  = { uid: "u5", token: { center_name: CENTER, role: "admin", active: false } };
const masterUser = { uid: "u6", token: { center_name: "Master", role: "user", active: true } };

const photo = `inspection_photos/${CENTER}/20260729_1430_기계_35_1.jpg`;

// [설명, 기대, auth(null=미인증), 객체경로, 메서드]
const cases = [
  // ── M-SMART 현장 점검 사진: 이 시스템에서 유일하게 브라우저가 직접 쓰는 경로 ──
  ["현장직원: 자기 센터 사진 업로드", "ALLOW", worker, photo, "create"],
  // 오프라인 큐가 같은 파일명으로 재전송하는 경우(업로드는 됐는데 응답을 못 받은 경우).
  // create만 허용하면 재시도가 영구 거부되어 큐에 갇히므로 update는 일부러 허용한다.
  ["현장직원: 같은 파일 재전송(오프라인 큐)", "ALLOW", worker, photo, "update"],
  ["현장직원: 자기 센터 사진 조회", "ALLOW", worker, photo, "get"],
  ["현장직원: 사진 삭제 시도", "DENY", worker, photo, "delete"], // 부정점검 방지 증빙
  ["현장직원: 남의 센터에 업로드", "DENY", worker, `inspection_photos/${OTHER}/x_1.jpg`, "create"],
  ["현장직원: 남의 센터 사진 조회", "DENY", worker, `inspection_photos/${OTHER}/x_1.jpg`, "get"],
  ["미인증: 사진 조회", "DENY", null, photo, "get"],
  ["미인증: 사진 업로드", "DENY", null, photo, "create"],
  ["Master: 타 센터 사진 조회", "ALLOW", master, photo, "get"],

  // ── M-Engine 산출물 / 근무일지: 브라우저는 읽기만 ──
  ["직원: 자기 센터 점검표 엑셀 조회", "ALLOW", worker, `excel/${CENTER}/a.xlsx`, "get"],
  ["직원: 점검표 엑셀 덮어쓰기 시도", "DENY", worker, `excel/${CENTER}/a.xlsx`, "update"],
  ["직원: 점검표 엑셀 삭제 시도", "DENY", worker, `excel/${CENTER}/a.xlsx`, "delete"],
  ["직원: 근무일지 엑셀 조회", "ALLOW", worker, `work_log/${CENTER}/2026년_7월_점검표.xlsx`, "get"],
  ["직원: 근무일지 엑셀 삭제 시도", "DENY", worker, `work_log/${CENTER}/2026년_7월_점검표.xlsx`, "delete"],

  // ── 템플릿: 읽기는 로그인, 쓰기는 관리자(role="admin") ──
  // [2026-08-04] 전환기 폴백 제거 — role이 없는 옛 토큰은 이제 관리자가 아니다.
  // 아래 두 줄이 "ALLOW"로 되돌아가면 폴백이 부활한 것이다(= active:true 하나로 관리자).
  ["[폴백제거] 직원(role없음+active=false): 템플릿 업로드", "DENY", worker, `templates/${CENTER}/work_sheet.xlsx`, "create"],
  ["[폴백제거] 옛 토큰(role없음+active=true): 템플릿 업로드", "DENY", admin_, `templates/${CENTER}/work_sheet.xlsx`, "create"],
  ["관리자: 템플릿 삭제 시도", "DENY", admin_, `templates/${CENTER}/work_sheet.xlsx`, "delete"],
  ["직원: 자기 센터 템플릿 조회", "ALLOW", worker, `templates/${CENTER}/work_sheet.xlsx`, "get"],

  // [2026-08-01] 읽기를 isSignedIn() → ownsCenter(center)로 좁힌 것에 대한 케이스.
  // work_sheet.xlsx는 빈 양식이 아니라 **직원 성명 + 월 근무표가 든 실 데이터**라,
  // 예전엔 로그인만 하면 남의 센터 직원 명단을 받을 수 있었다. 실 센터가 하나뿐이라
  // 증상이 없었을 뿐이고, 센터가 늘면 그 순간 열리는 구멍이었다.
  ["직원: 남의 센터 템플릿 조회", "DENY", worker, `templates/${OTHER}/work_sheet.xlsx`, "get"],
  ["관리자: 남의 센터 템플릿 업로드", "DENY", admin_, `templates/${OTHER}/work_sheet.xlsx`, "create"],
  ["Master: 남의 센터 템플릿 조회는 가능(범위가 전 센터)", "ALLOW", master, `templates/${OTHER}/work_sheet.xlsx`, "get"],
  // templates/report/event.xlsx는 {center}="report"로 매칭되어 이제 브라우저에선 안 읽힌다.
  // report-export.js가 Admin SDK로 읽으므로 규칙과 무관 — 보고서 생성은 영향 없다.
  ["직원: 공용 보고서 양식 직접 조회(Admin SDK 전용 경로)", "DENY", worker, "templates/report/event.xlsx", "get"],

  // [백필 후] role이 있으면 role이 이긴다.
  // ⚠️ 아래 첫 줄이 이 파일에서 가장 중요한 케이스다 — 백필하면 현장 작업자도 active:true가
  //   되므로, 규칙이 아직 active를 보고 있으면 **작업자 전원이 템플릿을 덮어쓸 수 있게 된다.**
  ["[백필후] 직원(role=user, active=true): 템플릿 업로드", "DENY", workerRole, `templates/${CENTER}/work_sheet.xlsx`, "create"],
  ["[백필후] 관리자(role=admin, active=false): 템플릿 업로드", "ALLOW", adminRole, `templates/${CENTER}/work_sheet.xlsx`, "create"],
  // Master는 '데이터 범위'이지 '권한'이 아니다 — 예전처럼 `|| isMaster`로 OR를 걸면 여기서 깨진다.
  ["[백필후] Master지만 role=user: 템플릿 업로드", "DENY", masterUser, `templates/${CENTER}/work_sheet.xlsx`, "create"],
  ["[백필후] Master지만 role=user: 템플릿 조회는 가능(권한은 없어도 범위는 전 센터)", "ALLOW", masterUser, `templates/${CENTER}/work_sheet.xlsx`, "get"],

  // role 도입이 M-SMART 현장 업로드를 건드리지 않는지 — 사진 경로는 ownsCenter(센터)만 본다.
  ["[백필후] 직원(role=user): 자기 센터 사진 업로드는 계속 가능", "ALLOW", workerRole, photo, "create"],
  ["[백필후] 직원(role=user): 남의 센터 사진 업로드는 여전히 차단", "DENY", workerRole, `inspection_photos/${OTHER}/x_1.jpg`, "create"],

  // ── 완료 사진(2026-08-14 신규): 쓰기는 관리자만, 읽기는 센터 구성원 ──
  // 점검 사진과 달리 쓰기를 좁힌 이유: 현장 점검자가 남기는 기록이 아니라, 관리 주체가
  // 보고서(완료사진1·2 열)에 실어 내보내는 자료라 작성 주체를 관리자로 한정했다.
  // ⚠️ 아래 첫 줄이 "ALLOW"로 바뀌면 그 구분이 사라진 것이다.
  ["[완료사진] 직원(role=user): 업로드 시도", "DENY", workerRole, `completion_photos/${CENTER}/e1_1.jpg`, "create"],
  ["[완료사진] 관리자: 자기 센터 업로드", "ALLOW", adminRole, `completion_photos/${CENTER}/e1_1.jpg`, "create"],
  // 같은 경로 덮어쓰기가 곧 '교체'다(삭제는 안 열었다). update가 막히면 교체 수단이 없어진다.
  ["[완료사진] 관리자: 같은 경로 덮어쓰기(교체)", "ALLOW", adminRole, `completion_photos/${CENTER}/e1_1.jpg`, "update"],
  ["[완료사진] 관리자: 삭제 시도", "DENY", adminRole, `completion_photos/${CENTER}/e1_1.jpg`, "delete"],
  ["[완료사진] 관리자: 남의 센터 업로드", "DENY", adminRole, `completion_photos/${OTHER}/e1_1.jpg`, "create"],
  // 읽기는 완료 팝업에서 누구나 확인할 수 있어야 한다(자기 센터 한정).
  ["[완료사진] 직원(role=user): 자기 센터 조회", "ALLOW", workerRole, `completion_photos/${CENTER}/e1_1.jpg`, "get"],
  ["[완료사진] 직원(role=user): 남의 센터 조회", "DENY", workerRole, `completion_photos/${OTHER}/e1_1.jpg`, "get"],
  ["[완료사진] 미인증: 조회", "DENY", null, `completion_photos/${CENTER}/e1_1.jpg`, "get"],

  // ── 서버 전용 산출물: 서명 URL로만 배포(서명 URL은 규칙을 우회하므로 영향 없음) ──
  ["직원: 이벤트 보고서 직접 조회", "DENY", worker, `report/${CENTER}/a.xlsx`, "get"],
  ["직원: 엑셀 통합본 직접 조회", "DENY", worker, `excel_merge/${CENTER}/a.xlsx`, "get"],

  // ── 기본 차단 (예전엔 여기가 allow read, write: if true 였다) ──
  ["미인증: 임의 경로 읽기", "DENY", null, "aaa/bbb.txt", "get"],
  ["미인증: 임의 경로 쓰기", "DENY", null, "aaa/bbb.txt", "create"],
];

(async () => {
  const rules = fs.readFileSync(RULES_PATH, "utf8");
  let token;
  try {
    token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  } catch (e) {
    console.error("gcloud 액세스 토큰을 못 가져왔습니다. `gcloud auth login` 후 다시 실행하세요.");
    process.exit(2);
  }

  const res = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}:test`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-goog-user-project": PROJECT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: { files: [{ name: "storage.rules", content: rules }] },
      testSuite: {
        testCases: cases.map(([, expectation, auth, objectPath, method]) => ({
          expectation,
          // Storage 규칙의 리소스 경로 형식. Firestore 형식
          // (/databases/(default)/documents/...)을 쓰면 어떤 match에도 안 걸려서
          // 모든 요청이 DENY로 나오고, DENY 테스트만 전부 통과하는 착시가 생긴다.
          request: { auth, path: `/b/${BUCKET}/o/${objectPath}`, method },
        })),
      },
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error("Rules API 오류:", JSON.stringify(body).slice(0, 800));
    process.exit(2);
  }
  if (body.issues && body.issues.length) {
    console.error("규칙 컴파일 이슈:", JSON.stringify(body.issues).slice(0, 800));
    process.exit(2);
  }

  const results = body.testResults || [];
  let failed = 0;
  results.forEach((r, i) => {
    const ok = r.state === "SUCCESS";
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${cases[i][0]}  (기대 ${cases[i][1]})`);
  });

  console.log("");
  console.log(failed === 0 ? `전체 통과 (${results.length}건)` : `실패 ${failed}건 / ${results.length}건`);
  process.exit(failed === 0 ? 0 : 1);
})();

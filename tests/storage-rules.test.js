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

// loginWithCredentials가 커스텀 토큰에 심는 클레임 형태 그대로
const worker = { uid: "u1", token: { center_name: CENTER, active: false } }; // 현장 직원
const admin_ = { uid: "u2", token: { center_name: CENTER, active: true } };  // 센터 관리자
const master = { uid: "u3", token: { center_name: "Master", active: true } };

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

  // ── 템플릿: 읽기는 로그인, 쓰기는 관리자(active=true)/Master ──
  ["직원(active=false): 템플릿 업로드", "DENY", worker, `templates/${CENTER}/work_sheet.xlsx`, "create"],
  ["관리자(active=true): 템플릿 업로드", "ALLOW", admin_, `templates/${CENTER}/work_sheet.xlsx`, "create"],
  ["관리자: 템플릿 삭제 시도", "DENY", admin_, `templates/${CENTER}/work_sheet.xlsx`, "delete"],
  ["직원: 템플릿 조회", "ALLOW", worker, `templates/${CENTER}/work_sheet.xlsx`, "get"],

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

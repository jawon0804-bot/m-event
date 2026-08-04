// tests/permissions.test.js
// functions/lib/permissions.js의 권한 판정을 고정한다. 외부 의존이 없어서 그냥 돌아간다.
//
// 실행:
//   node tests/permissions.test.js
//
// [왜 이 테스트가 있는가]
// 2026-08-01까지 `active: true` 필드 하나가 세 가지를 겸하고 있었다 —
// ①계정 활성 ②관리자 권한 ③알림메일 수신. 그래서 "메일을 받게 하려고 active를 켜면
// 그 사람이 센터 전체 보고서 권한과 Dashboard 접근까지 자동으로 얻는" 상태였다.
// 축을 role / active / notify_email로 쪼개면서 두 가지가 깨지기 쉬워졌다:
//
//   1) **fail-closed 방향** — [2026-08-04] 전환기 폴백(role이 없으면 active로 판정)을
//      제거했다. 이제 role이 없으면 관리자가 아니다. 아래 [2]번 그룹이 그걸 고정한다.
//      ⚠️ 이 그룹이 깨지면(= 폴백이 되살아나면) active:true 하나로 다시 관리자가 되어,
//      지금 분리한 "권한 ≠ 계정활성"이 조용히 원래대로 돌아간다.
//   2) **fail-open 방향** — active/notify_email은 값이 없을 때 각각 활성/수신으로 봐야
//      한다. 반대로 뒤집으면 현장이 로그인 못 하거나 알림이 조용히 끊긴다. [3]번 그룹.
//
// 그리고 [4]번 그룹은 "Master는 자동으로 관리자가 아니다"를 고정한다 — 예전 코드가
// `active || isMaster`로 OR를 걸어서 center_name이 범위와 권한을 겸하고 있었고,
// 그걸 되돌리면 "전 센터를 열람하되 보고서는 만들지 않는 계정"이 다시 표현 불가가 된다.
const assert = require("assert");
const {
  isAdmin, isMaster, isActiveAccount, wantsMail, shouldReceiveMail,
} = require("../functions/lib/permissions");

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    console.log(`  ✅ ${label}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${label}\n       기대: ${JSON.stringify(expected)}  실제: ${JSON.stringify(actual)}`);
    fail++;
  }
}

const CENTER = "쿠팡울산2Sub-Hub";

console.log("\n[1] role이 있으면 role이 이긴다 (백필 완료 후의 정상 동작)");
check("role:admin → 관리자", isAdmin({ role: "admin", center_name: CENTER }), true);
check("role:user → 일반", isAdmin({ role: "user", center_name: CENTER }), false);
check("role:admin이면 active:false여도 관리자 (축이 분리됐으므로)",
  isAdmin({ role: "admin", active: false }), true);
check("role:user면 active:true여도 일반 (role이 이긴다)",
  isAdmin({ role: "user", active: true }), false);

console.log("\n[2] fail-closed — role이 없으면 관리자가 아니다 (2026-08-04 폴백 제거)");
console.log("    ⚠️ 여기가 깨지면 active:true 하나로 다시 관리자가 되어 축 분리가 무효가 된다.");
check("role 없음 + active:true → 일반 (예전엔 폴백으로 관리자였다)", isAdmin({ active: true }), false);
check("role 없음 + active:false → 일반", isAdmin({ active: false }), false);
check("role 없음 + active 없음 → 일반", isAdmin({ center_name: CENTER }), false);
check("role:\"\"(빈 문자열) + active:true → 일반", isAdmin({ role: "", active: true }), false);
check("null/undefined → 일반 (throw 하지 않는다)", isAdmin(null), false);
check("role:\"ADMIN\"(대문자) → 일반 (정확일치만 인정)", isAdmin({ role: "ADMIN" }), false);

console.log("\n[3] fail-open 방향 — 값이 없을 때 잠기거나 끊기면 안 된다");
check("active 없음 → 활성으로 본다 (잘못 잠그면 현장이 멈춤)", isActiveAccount({}), true);
check("active:true → 활성", isActiveAccount({ active: true }), true);
check("active:false → 비활성 (명시적 차단만 인정)", isActiveAccount({ active: false }), false);
check("notify_email 없음 → 수신으로 본다 (조용히 끊기면 안 됨)", wantsMail({}), true);
check("notify_email:true → 수신", wantsMail({ notify_email: true }), true);
check("notify_email:false → 미수신", wantsMail({ notify_email: false }), false);

console.log("\n[4] Master는 '데이터 범위'이지 '권한'이 아니다");
console.log("    ⚠️ 여기에 `|| isMaster`를 되살리면 '전 센터 열람하되 보고서는 못 만드는 계정'이 다시 표현 불가가 된다.");
check("center_name:Master → 범위는 전 센터", isMaster({ center_name: "Master" }), true);
check("일반 센터 → 전 센터 아님", isMaster({ center_name: CENTER }), false);
check("Master + role:user → 관리자가 아니다",
  isAdmin({ center_name: "Master", role: "user" }), false);
check("Master + role:admin → 관리자",
  isAdmin({ center_name: "Master", role: "admin" }), true);
check("Master + role 없음 + active:true → 관리자 아님 (폴백 제거 후)",
  isAdmin({ center_name: "Master", active: true }), false);

console.log("\n[5] 알림메일 수신 대상 = 활성 + 관리자 + 수신 거부 안 함");
check("관리자 + 수신 → 받는다",
  shouldReceiveMail({ role: "admin", active: true, notify_email: true }), true);
check("관리자 + notify_email 없음 → 받는다 (fail-open)",
  shouldReceiveMail({ role: "admin", active: true }), true);
check("관리자지만 수신 거부 → 안 받는다 (관리자라도 메일은 싫을 수 있다)",
  shouldReceiveMail({ role: "admin", active: true, notify_email: false }), false);
check("일반 사용자는 수신 설정과 무관하게 안 받는다",
  shouldReceiveMail({ role: "user", active: true, notify_email: true }), false);
check("비활성 계정(퇴사자)은 관리자여도 안 받는다",
  shouldReceiveMail({ role: "admin", active: false, notify_email: true }), false);
check("role 없음 + active:true → 안 받는다 (폴백 제거 후 fail-closed)",
  shouldReceiveMail({ active: true }), false);
check("role 없음 + active:false → 안 받는다",
  shouldReceiveMail({ active: false }), false);

console.log("\n[6] 잘못된 입력에 터지지 않는다 (Firestore 문서가 비어 오는 경우 등)");
check("null", isAdmin(null), false);
check("undefined", isAdmin(undefined), false);
check("빈 객체", isAdmin({}), false);
check("shouldReceiveMail(null)", shouldReceiveMail(null), false);
check("isMaster(null)", isMaster(null), false);

console.log("");
console.log(fail === 0 ? `전체 통과 (${pass}건)` : `실패 ${fail}건 / ${pass + fail}건`);
process.exit(fail === 0 ? 0 : 1);

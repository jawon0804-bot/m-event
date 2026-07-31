// tests/expected-count.test.js
// 월간 집계의 "기대 생성 횟수" 계산을 고정한다.
//
// 실행:
//   node tests/expected-count.test.js
//
// [왜 이 테스트가 있는가]
// 같은 계산이 **두 언어로 두 벌** 존재한다.
//   M-Engine(Python)  lib/scheduler.py 의 calc_expected_count   → 월간 요약 "메일"
//   m-event(JS)       manager/js/report-tab.js 의 calcExpectedCount → 보고서 "화면"
// 한쪽만 고치면 메일 숫자와 화면 숫자가 조용히 달라진다. 실제로 2026-07-27에
// 월간 집계 상한 경계가 서로 어긋난 것이 발견돼 맞춘 이력이 있다.
//
// 근본 해결(한쪽을 API로 노출하거나 집계 결과를 캐시)은 아직 안 했으므로, 대신
// **양쪽이 같은 케이스 표를 통과하는지**를 각 언어의 테스트로 고정한다.
// 아래 CASES는 M-Engine/tests/test_schedule_dates.py 의 표와 **글자 그대로 같아야 한다.**
// 한쪽 표를 고치면 반드시 다른 쪽도 같이 고칠 것.
//
// [왜 import 대신 소스에서 함수를 떼어내는가]
// report-tab.js는 브라우저 코드라 document/db 같은 전역에 의존해서 Node에서 그냥
// require할 수 없다. 그런데 calcExpectedCount 자체는 Date만 쓰는 순수 함수다.
// 그래서 실제 소스 파일에서 그 함수 본문만 꺼내 실행한다 — M-Engine 쪽 테스트가
// AST로 같은 일을 하는 것과 같은 방식이고, "진짜 배포되는 코드"를 검증하게 된다.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "manager", "js", "report-tab.js");

function loadCalcExpectedCount() {
  const src = fs.readFileSync(SRC, "utf8");
  const start = src.indexOf("function calcExpectedCount");
  if (start === -1) {
    throw new Error("report-tab.js에서 calcExpectedCount를 찾지 못했습니다 (이름이 바뀌었나요?)");
  }
  // 함수 시작부터 중괄호 균형이 맞는 지점까지 잘라낸다.
  let depth = 0, end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error("calcExpectedCount의 끝을 찾지 못했습니다");
  const fnText = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${fnText}; return calcExpectedCount;`)();
}

// ⚠️ 이 표는 M-Engine/tests/test_schedule_dates.py 의 EXPECTED_COUNT_CASES와 동일해야 한다.
// [schedule_type, year, month, 기대값]
const CASES = [
  ["daily",   2026, 1,  31],
  ["daily",   2026, 2,  28],
  ["daily",   2024, 2,  29], // 윤년
  ["daily",   2026, 4,  30],
  ["monthly", 2026, 1,  1],
  ["monthly", 2026, 8,  1],
  ["weekly",  2026, 1,  4],
  ["weekly",  2026, 2,  4],
  ["weekly",  2026, 4,  4],
  ["weekly",  2026, 8,  5],  // 월요일이 5번인 달
  ["weekly",  2026, 11, 5],
  ["weekly",  2027, 3,  5],
  ["unknown", 2026, 1,  null], // 집계 대상 아님
  ["",        2026, 1,  null],
];

const calcExpectedCount = loadCalcExpectedCount();

let pass = 0, fail = 0;
console.log("\n[월간 집계] 기대 생성 횟수 — M-Engine(Python)과 동일한 케이스 표");
for (const [type, year, month, expected] of CASES) {
  const actual = calcExpectedCount(type, year, month);
  if (actual === expected) {
    console.log(`  ✅ ${type || "(빈값)"} ${year}-${String(month).padStart(2, "0")} → ${actual}`);
    pass++;
  } else {
    console.log(`  ❌ ${type || "(빈값)"} ${year}-${String(month).padStart(2, "0")}  기대: ${expected}  실제: ${actual}`);
    fail++;
  }
}

console.log(`\n결과: ${pass}건 통과, ${fail}건 실패`);
if (fail === 0) {
  console.log("📌 M-Engine 쪽도 같이 확인하세요: cd M-Engine && python tests/test_schedule_dates.py\n");
}
process.exit(fail === 0 ? 0 : 1);

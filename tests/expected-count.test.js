// tests/expected-count.test.js
// 월간 집계의 "기대 생성 횟수"와 회차 구간 계산을 고정한다.
//
// 실행:
//   node tests/expected-count.test.js
//
// [왜 이 테스트가 있는가]
// 같은 계산이 **두 언어로 두 벌** 존재한다.
//   M-Engine(Python)  lib/scheduler.py 의 calc_expected_count   → 월간 요약 "메일"
//   m-event(JS)       manager/js/report-tab.js 의 buildInspPeriods → 보고서 "화면"
// 한쪽만 고치면 메일 숫자와 화면 숫자가 조용히 달라진다. 실제로 2026-07-27에
// 월간 집계 상한 경계가 서로 어긋난 것이 발견돼 맞춘 이력이 있다.
//
// ⚠️ [2026-08-20] JS 쪽 함수가 `calcExpectedCount`(횟수만 반환) →
//   `buildInspPeriods`(회차 목록을 반환)로 바뀌었다. 설비별 완료 집계를 하려면
//   "몇 번"이 아니라 "각 회차가 언제부터 언제까지인지"가 필요해서다.
//   **반환 배열의 길이가 곧 예전 calcExpectedCount의 값**이라, 아래 CASES 표는
//   그대로 두고 길이를 비교한다. 두 벌이 더 벌어졌으므로(구간·06:00 경계까지 복제됨)
//   PERIOD_CASES로 구간 자체도 같이 고정한다.
//
// 근본 해결(한쪽을 API로 노출하거나 집계 결과를 캐시)은 아직 안 했으므로, 대신
// **양쪽이 같은 케이스 표를 통과하는지**를 각 언어의 테스트로 고정한다.
// 아래 CASES는 M-Engine/tests/test_schedule_dates.py 의 표와 **글자 그대로 같아야 한다.**
// 한쪽 표를 고치면 반드시 다른 쪽도 같이 고칠 것.
//
// [왜 import 대신 소스에서 함수를 떼어내는가]
// report-tab.js는 브라우저 코드라 document/db 같은 전역에 의존해서 Node에서 그냥
// require할 수 없다. 그런데 회차 계산 자체는 Date만 쓰는 순수 함수다.
// 그래서 실제 소스 파일에서 그 함수 본문만 꺼내 실행한다 — M-Engine 쪽 테스트가
// AST로 같은 일을 하는 것과 같은 방식이고, "진짜 배포되는 코드"를 검증하게 된다.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "manager", "js", "report-tab.js");

// `function 이름(...) { ... }` 한 덩어리를 중괄호 균형으로 잘라낸다.
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start === -1) {
    throw new Error(`report-tab.js에서 ${name}을 찾지 못했습니다 (이름이 바뀌었나요?)`);
  }
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name}의 끝을 찾지 못했습니다`);
}

function loadBuildInspPeriods() {
  const src = fs.readFileSync(SRC, "utf8");
  // buildInspPeriods가 기대는 것: 06:00 상수, 자리수 패딩(_p2), 날짜 이동(inspShiftDate).
  const constLine = src.match(/const INSP_BUSINESS_DAY_START = [^\n]*/);
  const p2Line    = src.match(/const _p2 = [^\n]*/);
  if (!constLine || !p2Line) {
    throw new Error("report-tab.js에서 INSP_BUSINESS_DAY_START / _p2를 찾지 못했습니다");
  }
  const fnText = [
    constLine[0],
    p2Line[0],
    sliceFunction(src, "inspShiftDate"),
    sliceFunction(src, "buildInspPeriods"),
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(`${fnText}; return buildInspPeriods;`)();
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

// 회차 구간 자체를 고정한다. 근거는 M-Engine lib/scheduler.py의 calc_schedule_dates와
// lib/config.py의 BUSINESS_DAY_START_HOUR(=6).
// [schedule_type, year, month, 회차 인덱스, 기대 start, 기대 end]
const PERIOD_CASES = [
  // daily: 06:00 ~ 익일 06:00 (자정이 아니다 — 야간 점검을 전날로 귀속시키는 규칙)
  ["daily",   2026, 7,  0, "2026-07-01 06:00", "2026-07-02 06:00"],
  ["daily",   2026, 7, 30, "2026-07-31 06:00", "2026-08-01 06:00"], // 말일 → 익월로 넘어감
  ["daily",   2024, 2, 27, "2024-02-28 06:00", "2024-02-29 06:00"], // 윤년 경계
  ["daily",   2024, 2, 28, "2024-02-29 06:00", "2024-03-01 06:00"],
  // monthly: 그 달 1일 00:00 ~ 익월 1일 00:00 (캘린더 기준)
  ["monthly", 2026, 7,  0, "2026-07-01 00:00", "2026-08-01 00:00"],
  ["monthly", 2026, 12, 0, "2026-12-01 00:00", "2027-01-01 00:00"], // 연 경계
  // weekly: 월요일에 "지난주 월~일"을 만든다 → 그 달 첫 회차는 전월 말주를 가리킨다
  ["weekly",  2026, 8,  0, "2026-07-27 00:00", "2026-08-03 00:00"],
  ["weekly",  2026, 8,  4, "2026-08-24 00:00", "2026-08-31 00:00"],
];

const buildInspPeriods = loadBuildInspPeriods();

let pass = 0, fail = 0;

console.log("\n[월간 집계] 기대 생성 횟수 — M-Engine(Python)과 동일한 케이스 표");
for (const [type, year, month, expected] of CASES) {
  // 빈 배열 = 집계 대상 아님. 예전 calcExpectedCount의 null과 같은 뜻이다
  // (daily/weekly/monthly는 어느 달이든 회차가 최소 1개라 0이 나올 수 없다).
  const periods = buildInspPeriods(type, year, month);
  const actual = periods.length === 0 ? null : periods.length;
  if (actual === expected) {
    console.log(`  ✅ ${type || "(빈값)"} ${year}-${String(month).padStart(2, "0")} → ${actual}`);
    pass++;
  } else {
    console.log(`  ❌ ${type || "(빈값)"} ${year}-${String(month).padStart(2, "0")}  기대: ${expected}  실제: ${actual}`);
    fail++;
  }
}

console.log("\n[월간 집계] 회차 구간 — 06:00 경계 / 월·연 경계 / weekly는 지난주");
for (const [type, year, month, idx, start, end] of PERIOD_CASES) {
  const p = buildInspPeriods(type, year, month)[idx];
  const label = `${type} ${year}-${String(month).padStart(2, "0")} #${idx}`;
  if (p && p.start === start && p.end === end) {
    console.log(`  ✅ ${label} → ${p.start} ~ ${p.end}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}  기대: ${start} ~ ${end}  실제: ${p ? `${p.start} ~ ${p.end}` : "(없음)"}`);
    fail++;
  }
}

console.log(`\n결과: ${pass}건 통과, ${fail}건 실패`);
if (fail === 0) {
  console.log("📌 M-Engine 쪽도 같이 확인하세요: cd M-Engine && python tests/test_schedule_dates.py\n");
}
process.exit(fail === 0 ? 0 : 1);

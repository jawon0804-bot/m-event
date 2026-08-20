// tests/func-key.test.js
// Maxerve_Excel 문서 → 점검표(func_key) 판정을 고정한다.
//
// 실행:
//   node tests/func-key.test.js
//
// [왜 이 테스트가 있는가]
// 점검표 서브탭의 "실제" 건수는 예전엔 `facility_id`(=fids를 콤마로 이은 문자열)로
// Maxerve_Excel 문서를 세었다. 그런데 그 문자열은 **생성 시점의 fids**라, 점검표
// 설정에서 설비를 하나 빼거나 더하면 과거 생성분이 통째로 매칭에서 빠진다.
// 실제로 집수정펌프가 `기계_41~47`로 생성돼 있는데 설정이 `기계_41~45`로 바뀌어서,
// 파일이 멀쩡히 있는데도 화면과 메일 양쪽에서 "0건 부족"으로 나왔다(2026-08-20 발견).
//
// 그래서 점검표 정체성을 **func_key**(변하지 않는 문서 ID)로 잡는다. 새 문서는
// M-Engine이 `func_key` 필드를 같이 저장하고, 그 필드가 없는 옛 문서는 storage_path
// 에서 되뽑는다. 이 되뽑기 규칙이 어긋나면 다시 조용히 0건이 되므로 여기서 고정한다.
//
// ⚠️ 아래 CASES는 M-Engine/tests/test_func_key.py 의 FUNC_KEY_CASES와
//    **글자 그대로 같아야 한다.** 같은 판정이 두 언어로 두 벌 존재한다:
//      M-Engine(Python) func_key_from_storage_path → 월간 요약 "메일"
//      m-event(JS)      inspFuncKeyFromPath        → 보고서 "화면"
//    한쪽 표를 고치면 반드시 다른 쪽도 같이 고칠 것.
//
// [왜 import 대신 소스에서 함수를 떼어내는가]
// report-tab.js는 브라우저 코드라 document/db 같은 전역에 의존해서 Node에서 그냥
// require할 수 없다. 이 두 함수는 순수 문자열 처리라 소스에서 떼어내 실행한다
// (expected-count.test.js와 같은 방식).
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "manager", "js", "report-tab.js");

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

function loadFuncKeyFunctions() {
  const src = fs.readFileSync(SRC, "utf8");
  const fnText = [
    sliceFunction(src, "inspFuncKeyFromPath"),
    sliceFunction(src, "inspDocFuncKey"),
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(`${fnText}; return { inspFuncKeyFromPath, inspDocFuncKey };`)();
}

// [storage_path, center_name, 기대 func_key]
const CASES = [
  // 정상 — func_key에 밑줄이 있어도 마지막 밑줄(날짜) 기준으로 잘린다
  ["excel/쿠팡울산2Sub-Hub/쿠팡울산2Sub-Hub_JIP_PUMP_2026-07-01.xlsx", "쿠팡울산2Sub-Hub", "JIP_PUMP"],
  ["excel/쿠팡울산2Sub-Hub/쿠팡울산2Sub-Hub_ICT_01_2026-07-27.xlsx",   "쿠팡울산2Sub-Hub", "ICT_01"],
  ["excel/쿠팡울산2Sub-Hub/쿠팡울산2Sub-Hub_OHD_STR_2026-07-23.xlsx",  "쿠팡울산2Sub-Hub", "OHD_STR"],
  // 수동 트리거는 날짜 뒤에 M이 붙는다(M-Engine output_filename 참고)
  ["excel/쿠팡울산2Sub-Hub/쿠팡울산2Sub-Hub_DOCK_STR_2026-07-23M.xlsx", "쿠팡울산2Sub-Hub", "DOCK_STR"],
  // 센터명에 밑줄이 있어도 접두사로 떼므로 안전
  ["excel/A_B센터/A_B센터_ELEC_LOG_2026-08-01.xlsx", "A_B센터", "ELEC_LOG"],
  // 판정 불가 → 빈 문자열(호출부가 facility_id 매칭으로 폴백)
  ["excel/다른센터/다른센터_X_2026-08-01.xlsx", "우리센터", ""],   // 센터명 불일치
  ["excel/센터/센터_2026-08-01.xlsx",           "센터",     ""],   // func_key 자리가 없음
  ["",                                          "센터",     ""],   // 경로 없음
  [null,                                        "센터",     ""],
  ["excel/센터/센터_WATER_TANK_2026-08-01.xlsx", "",         ""],   // 센터명 없음
];

// [문서, 기대 func_key] — 필드가 있으면 그걸 쓰고, 없으면 경로에서 되뽑는다
const RESOLVE_CASES = [
  [{ func_key: "OHD_STR", storage_path: "excel/센터/센터_JIP_PUMP_2026-08-01.xlsx", center_name: "센터" }, "OHD_STR"],
  [{ storage_path: "excel/센터/센터_JIP_PUMP_2026-08-01.xlsx", center_name: "센터" }, "JIP_PUMP"],
  [{ func_key: "  ", storage_path: "excel/센터/센터_ELEV_1_2026-08-01.xlsx", center_name: "센터" }, "ELEV_1"],
  [{ facility_id: "기계_01,기계_02" }, ""],
];

const { inspFuncKeyFromPath, inspDocFuncKey } = loadFuncKeyFunctions();

let pass = 0, fail = 0;

console.log("\n[1] storage_path → func_key");
for (const [p, center, expected] of CASES) {
  const actual = inspFuncKeyFromPath(p, center);
  const label = `${String(p).slice(0, 58)} (center=${center || "(빈값)"})`;
  if (actual === expected) {
    console.log(`  ✅ ${label} → ${actual || "(빈값)"}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}  기대: ${expected || "(빈값)"}  실제: ${actual || "(빈값)"}`);
    fail++;
  }
}

console.log("\n[2] 문서 → func_key (필드 우선, 없으면 경로)");
for (const [data, expected] of RESOLVE_CASES) {
  const actual = inspDocFuncKey(data);
  if (actual === expected) {
    console.log(`  ✅ ${JSON.stringify(data).slice(0, 70)} → ${actual || "(빈값)"}`);
    pass++;
  } else {
    console.log(`  ❌ ${JSON.stringify(data).slice(0, 70)}  기대: ${expected || "(빈값)"}  실제: ${actual || "(빈값)"}`);
    fail++;
  }
}

console.log(`\n결과: ${pass}건 통과, ${fail}건 실패`);
if (fail === 0) {
  console.log("📌 M-Engine 쪽도 같이 확인하세요: cd M-Engine && python tests/test_func_key.py\n");
}
process.exit(fail === 0 ? 0 : 1);

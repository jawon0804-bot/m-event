// tests/issue-text.test.js
// 이슈 본문 합성(buildIssueText)과 메일 제목 축약(forSubject)을 고정한다.
//
// 실행:
//   node tests/issue-text.test.js
//
// [왜 이 테스트가 있는가]
// M-SMART가 2026-08-14부터 점검 항목마다 특이사항을 받는다(inspection_logs의
// results[i].note). onInspectionLog는 그전까지 최상위 memo 필드 **하나만** 봤기 때문에,
// 합성을 빠뜨리면 **작업자가 특이사항을 적어도 이슈도 메일도 안 나간다.**
// 저장은 되는데 아무도 모르는, 증상이 안 보이는 종류의 사고다.
//
// 특히 아래 두 가지는 되돌리기 쉬운 부분이라 케이스로 굳혀둔다.
//   ① 재발화 방지 비교(issueText === prevIssueText)를 한쪽만 원본 memo로 하면,
//      특이사항만 바뀐 수정이 "memo는 그대로"로 판정돼 이슈가 갱신되지 않는다.
//   ② 제목 축약을 빼면, 라벨이 점검기준 전문이라 메일 제목이 100자를 넘어간다.
//      제목에 개행이 섞이는 것도 여기서 막는다(헤더에 개행이 들어가면 안 된다).
//
// [왜 require 대신 소스에서 함수를 떼어내는가]
// lib/events.js는 firebase-functions/firebase-admin을 로드해서 Node에서 그냥
// require할 수 없다(자격증명·초기화 필요). 그런데 이 두 함수는 입력만 보는 순수
// 함수다. 그래서 실제 소스에서 해당 구간만 꺼내 실행한다 —
// tests/expected-count.test.js가 report-tab.js에 대해 하는 것과 같은 방식이고,
// "진짜 배포되는 코드"를 검증하게 된다.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "functions", "lib", "events.js");

function loadHelpers() {
  const src = fs.readFileSync(SRC, "utf8");
  const start = src.indexOf("const LABEL_MAX");
  const end = src.indexOf("// [트리거 1]");
  if (start < 0 || end < 0) {
    throw new Error("events.js에서 헬퍼 구간(LABEL_MAX ~ 트리거 1)을 찾지 못했습니다 — 소스 구조가 바뀌었는지 확인하세요.");
  }
  const snippet = src.slice(start, end);
  const factory = new Function(`${snippet}; return { buildIssueText, forSubject, shortenLabel };`);
  return factory();
}

const { buildIssueText, forSubject } = loadHelpers();

let failed = 0;
function eq(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`      got : ${JSON.stringify(got)}`);
    console.log(`      want: ${JSON.stringify(want)}`);
  }
}

const LONG_LABEL = "3.공기흡입형 감지기함은 정상작동 녹색점등과 경고표시가 있는지 확인할것.";

// ── 합성 ────────────────────────────────────────────────────────────────
eq("하단 종합 메모만 있으면 그대로",
  buildIssueText({ memo: "기계실 습기 많음", results: [{ label: "a", value: "양호" }] }),
  "기계실 습기 많음");

eq("항목별 특이사항만 있어도 이슈가 만들어져야 한다(이 기능의 핵심)",
  buildIssueText({ memo: "", results: [{ label: LONG_LABEL, value: "불량", note: "3존 경고등 점등" }] }),
  "[3.공기흡입형 감지기함은…] 3존 경고등 점등");

eq("둘 다 있으면 종합 메모가 앞",
  buildIssueText({ memo: "기계실 습기 많음", results: [{ label: "14.노후 및 파손부위는 없는가?", value: "불량", note: "배관 부식" }] }),
  "기계실 습기 많음 / [14.노후 및 파손부위는…] 배관 부식");

eq("특이사항 여러 건은 ' / '로 연결(개행 금지 — 제목에 그대로 들어간다)",
  buildIssueText({ memo: "", results: [
    { label: "냄새", value: "불량", note: "약품 냄새" },
    { label: "탁도", value: "양호" },
    { label: "색도", value: "불량", note: "황갈색" },
  ] }),
  "[냄새] 약품 냄새 / [색도] 황갈색");

eq("공백만 있는 note는 없는 것으로 본다",
  buildIssueText({ memo: "ok", results: [{ label: "a", value: "양호", note: "   " }] }), "ok");

eq("라벨이 없으면 내용만",
  buildIssueText({ memo: "", results: [{ label: "", value: "", note: "순찰 중 발견" }] }), "순찰 중 발견");

eq("전부 비면 빈 문자열 → 트리거가 조기 종료해야 한다",
  buildIssueText({ memo: "", results: [{ label: "a", value: "양호" }] }), "");

// 하위호환/방어: 예전 구조와 깨진 값이 들어와도 터지지 않아야 한다
eq("results 필드 자체가 없는 옛 문서", buildIssueText({ memo: "메모" }), "메모");
eq("results가 콤마 문자열이던 구포맷", buildIssueText({ memo: "메모", results: "양호,양호" }), "메모");
eq("data가 null", buildIssueText(null), "");
eq("note가 문자열이 아니면 무시", buildIssueText({ memo: "", results: [{ label: "a", note: 123 }] }), "");

// ── 재발화 방지 ─────────────────────────────────────────────────────────
const doc = { memo: "m", results: [{ label: "L", value: "불량", note: "n" }] };
eq("같은 내용이면 같은 문자열(중복 메일 방지)",
  buildIssueText(doc), buildIssueText(JSON.parse(JSON.stringify(doc))));

const changedNote = { memo: "m", results: [{ label: "L", value: "불량", note: "n2" }] };
eq("특이사항만 바뀌어도 결과가 달라져야 한다(이슈 갱신이 되도록)",
  buildIssueText(doc) !== buildIssueText(changedNote), true);

// ── 라벨 축약 ───────────────────────────────────────────────────────────
eq("공백 뒤가 긴 라벨은 정보가 남도록 글자 수로 자른다",
  buildIssueText({ memo: "", results: [{ label: "1. 전원공급반함은전압계창24V표시", note: "n" }] }),
  "[1. 전원공급반함은전압계창2…] n");

eq("공백 없는 라벨",
  buildIssueText({ memo: "", results: [{ label: "가나다라마바사아자차카타파하거너더", note: "n" }] }),
  "[가나다라마바사아자차카타파하거…] n");

// ── 제목 축약 ───────────────────────────────────────────────────────────
const many = buildIssueText({
  memo: "",
  results: Array.from({ length: 6 }, (_, i) => ({ label: `항목${i}`, note: `특이사항 내용 ${i}` })),
});
eq("긴 본문은 제목에서 60자+말줄임으로 잘린다", forSubject(many).length, 61);
eq("제목에서 개행 제거", forSubject("첫 줄\n둘째 줄\r\n셋째"), "첫 줄 둘째 줄 셋째");
eq("짧은 제목은 그대로", forSubject("짧음"), "짧음");

console.log(failed === 0 ? "\n✅ 전부 통과" : `\n❌ ${failed}건 실패`);
process.exit(failed === 0 ? 0 : 1);

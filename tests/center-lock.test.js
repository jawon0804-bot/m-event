// tests/center-lock.test.js
// manager/js/auth.js의 **센터 미선택 잠금**을 스텁 DOM 위에서 검증한다. 자격증명 불필요.
//
// 실행:
//   node tests/center-lock.test.js
//
// [왜 이 테스트가 있는가]
// 2026-08-05에 "Master가 로그인하면 전 센터를 조회하던" 동작을 없앴다. 센터를 고르는 곳은
// **이벤트 탭 드롭다운 하나뿐**이고, 고르기 전에는 나머지 탭(엑셀/사진/근무일지/보고서)이
// 잠긴다. 이 잠금이 풀리면 각 탭이 센터 없이 조회를 시도하고, 그때 필터가 빠진 쿼리가
// 다시 전 센터를 훑게 된다(센터 50곳이 목표라 그 경로는 그대로 두면 위험하다).
//
// 화면 조작이라 순수 함수로는 못 고정해서, DOM을 최소한으로 흉내 낸 뒤 auth.js에서 해당
// 함수만 떼어내 실행한다. M-Engine의 test_schedule_dates.py가 AST로 함수를 떼어내는 것과
// 같은 접근이다. 함수 이름이 바뀌면 **못 찾았다고 즉시 죽는다**(조용히 통과하지 않는다).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "manager", "js", "auth.js");
const src = fs.readFileSync(SRC, "utf8");

function extract(name, kind = "function") {
  const re = kind === "function"
    ? new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m")
    : new RegExp(`const ${name}\\s*=\\s*\\[[^\\]]*\\];`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`${name} 를 auth.js에서 못 찾음`);
  return m[0];
}

// ── 스텁 DOM ───────────────────────────────────────────────
function makeEl(attrs = {}) {
  const classes = new Set();
  return {
    dataset: attrs.dataset || {},
    title: "",
    style: {},
    innerHTML: "",
    textContent: "",
    focus() { this._focused = true; },
    classList: {
      toggle(c, on) { on ? classes.add(c) : classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    _classes: classes,
  };
}

const tabs = {
  event:   makeEl({ dataset: { page: "event" } }),
  excel:   makeEl({ dataset: { page: "excel" } }),
  photo:   makeEl({ dataset: { page: "photo" } }),
  worklog: makeEl({ dataset: { page: "worklog" } }),
  report:  makeEl({ dataset: { page: "report" } }),
};
const pages = {};
Object.keys(tabs).forEach(p => (pages[`page-${p}`] = makeEl()));
const misc = {
  "filter-center-event": makeEl(),
  "event-list": makeEl(), "excel-list": makeEl(), "photo-list": makeEl(),
  "report-file-list": makeEl(), "wl-center-label": makeEl(), "wl-title-text": makeEl(),
  "report-center-label": makeEl(),
  "center-name-excel": makeEl(), "center-name-photo": makeEl(),
  "center-name-report": makeEl(), "center-name-report-insp": makeEl(),
};

const document = {
  getElementById: (id) => misc[id] || pages[id] || null,
  querySelector: (sel) => {
    const m = sel.match(/\.main-tab\[data-page="(.+?)"\]/);
    return m ? tabs[m[1]] : null;
  },
  querySelectorAll: (sel) => {
    if (sel === ".main-tab") return Object.values(tabs);
    if (sel === ".page") return Object.entries(pages).map(([id, el]) => ({ ...el, id }));
    return [];
  },
};

// ── 테스트 대상 코드 ────────────────────────────────────────
let selectedCenter = "";          // currentCenter()가 돌려줄 값
const ctx = {
  document,
  currentPage: "event",
  currentCenter: () => selectedCenter,
  showCenterPromptForPage: () => {},
  wlCenter: null,
  wlInit: () => {},
  console,
};
vm.createContext(ctx);
vm.runInContext(
  [
    extract("LOCKABLE_PAGES", "const"),
    extract("lockTabsUntilCenter"),
    extract("switchPage"),
    extract("renderCenterLabels"),
  ].join("\n"),
  ctx
);

// ── 검증 ───────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "✅" : "❌"} ${label}` + (ok ? "" : `\n       기대: ${JSON.stringify(expected)}  실제: ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
};
const lockedTabs = () => Object.entries(tabs).filter(([, el]) => el.classList.contains("tab-locked")).map(([p]) => p).sort();

console.log("\n[1] 센터 미선택 — 이벤트 외 4개 탭이 잠긴다");
selectedCenter = "";
ctx.lockTabsUntilCenter();
check("잠긴 탭 목록", lockedTabs(), ["excel", "photo", "report", "worklog"]);
check("이벤트 탭은 안 잠김", tabs.event.classList.contains("tab-locked"), false);
check("잠긴 탭에 안내 title", tabs.excel.title, "먼저 이벤트 탭에서 센터를 선택하세요");

console.log("\n[2] 잠긴 탭은 클릭해도 이동하지 않는다");
ctx.currentPage = "event";
ctx.switchPage("excel");
check("currentPage 유지", ctx.currentPage, "event");
check("드롭다운에 포커스를 준다", misc["filter-center-event"]._focused, true);

console.log("\n[3] 센터를 고르면 잠금이 풀린다");
selectedCenter = "B센터";
ctx.lockTabsUntilCenter();
check("잠긴 탭 없음", lockedTabs(), []);
ctx.switchPage("worklog");
check("이제 이동된다", ctx.currentPage, "worklog");

console.log("\n[4] 잠긴 탭을 보던 중 센터가 미선택으로 돌아가면 이벤트 탭으로 되돌린다");
ctx.currentPage = "photo";
selectedCenter = "";
ctx.lockTabsUntilCenter();
check("이벤트 탭으로 복귀", ctx.currentPage, "event");
check("다시 잠김", lockedTabs(), ["excel", "photo", "report", "worklog"]);

console.log("\n[5] 이벤트 탭은 센터 미선택이어도 항상 들어갈 수 있다");
ctx.switchPage("event");
check("이벤트 탭 진입", ctx.currentPage, "event");

// ── 센터명 표시 ─────────────────────────────────────────────
// 드롭다운을 이벤트 탭 하나로 모으면서 다른 화면에서 "지금 보고 있는 센터"가 사라졌던
// 적이 있다(2026-08-05 배포 직후 지적). 조회 범위가 안 보이면 다른 센터 자료를 자기
// 것으로 오인할 수 있어서, 감춘 드롭다운 자리마다 센터명을 남긴다.
const badgeIds = ["center-name-excel", "center-name-photo", "center-name-report", "center-name-report-insp"];

console.log("\n[6] 센터를 고르면 감춘 드롭다운 자리에 센터명이 뜬다");
selectedCenter = "B센터";
ctx.renderCenterLabels();
check("탭 4곳의 센터명", badgeIds.map(id => misc[id].textContent), ["B센터", "B센터", "B센터", "B센터"]);
check("보고서 탭 상단 라벨", misc["report-center-label"].textContent, "📊 B센터");
check("미선택 스타일 아님", misc["center-name-excel"].classList.contains("center-fixed-empty"), false);

console.log("\n[7] 미선택이면 안내 문구가 뜬다 ('전체 센터'로 보이면 안 된다)");
selectedCenter = "";
ctx.renderCenterLabels();
check("탭 4곳", badgeIds.map(id => misc[id].textContent),
  ["센터를 선택하세요", "센터를 선택하세요", "센터를 선택하세요", "센터를 선택하세요"]);
check("보고서 탭 상단 라벨", misc["report-center-label"].textContent, "📊 센터를 선택하세요");
check("근무일지 라벨", misc["wl-center-label"].textContent, "📓 센터를 선택하세요");
check("미선택 스타일 적용", misc["center-name-excel"].classList.contains("center-fixed-empty"), true);

console.log(`\n${fail ? `실패 ${fail}건 / ` : "전체 통과 "}${pass + fail}건`);
process.exit(fail ? 1 : 0);

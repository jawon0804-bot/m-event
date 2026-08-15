// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────
function fmt(d) {
  const p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function fmtDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// ── 처리 결과 알림 (토스트) ───────────────────────────────────────────────
// alert()은 확인을 누를 때까지 화면을 막아서, 저장처럼 "됐다"만 알리면 되는 곳엔 과하다.
let toastTimer = null;
function showToast(text, isError) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast" + (isError ? " error" : ""); }, 2600);
}

// 버튼을 잠그고 스피너를 돌린 뒤 원래대로 되돌린다.
// 되돌리기를 finally에 두는 이유: 실패해도 버튼이 잠긴 채 남으면 다시 시도할 수 없다.
// (그 사이 화면이 다시 그려져 버튼이 교체됐다면 떨어져 나간 노드를 복원하는 것뿐이라 무해하다)
async function withSpinner(btn, label, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML, wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.innerHTML = `<span class="btn-spinner"></span>${esc(label)}`;
  try { return await fn(); }
  finally { btn.innerHTML = html; btn.disabled = wasDisabled; }
}

// HTML 이스케이프 — 작은따옴표(')까지 처리 (속성 값 삽입 시 안전)
function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
// photo_count가 문자열("3장")이든 숫자(3)든 안전하게 정수로 변환
function toCount(v) {
  const n = parseInt(String(v ?? "0").replace(/[^0-9]/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}
// 시작일~종료일 90일 초과 여부
function isOver90Days(start, end) {
  if (!start || !end) return false;
  return (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24) > 90;
}

// ── 페이지네이션 렌더링 ──
function renderPagination(containerId, total, current, onPageClick) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) { el.innerHTML = ""; return; }
  let html = "";
  if (current > 1) html += `<button class="page-btn" onclick="${onPageClick}(${current-1})">‹</button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - current) <= 2) {
      html += `<button class="page-btn${i===current?" active":""}" onclick="${onPageClick}(${i})">${i}</button>`;
    } else if (Math.abs(i - current) === 3) {
      html += `<span style="padding:0 4px">...</span>`;
    }
  }
  if (current < totalPages) html += `<button class="page-btn" onclick="${onPageClick}(${current+1})">›</button>`;
  el.innerHTML = html;
}

// ──────────────────────────────────────────────
// 센터 선택 (2026-08-05 신설)
//
// 그전까지 Master는 각 탭 드롭다운의 기본값이 "전체"였고, 그러면 각 쿼리가 center_name
// 필터 없이 **전 센터**를 조회했다. 센터가 늘수록 그것만 무거워지는 구조라
// (facility-dashboard도 같은 이유로 2026-08-05에 전 센터 합산 조회를 없앴다),
// 기본값을 "센터를 선택하세요"로 바꾸고 고르기 전에는 조회 자체를 하지 않는다.
//
// 📌 **센터를 고르는 곳은 이벤트 탭 드롭다운 하나뿐이다**(2026-08-05 결정).
//    탭마다 드롭다운이 있으면 어디서 고른 값이 유효한지 헷갈리고, 탭을 옮길 때마다
//    다시 고르게 된다. 나머지 탭의 select는 화면에서 감추고 값만 같이 맞춰서
//    (syncCenterSelects) 각 탭 코드가 예전처럼 자기 select를 읽어도 그대로 동작하게 했다.
//    센터를 고르기 전에는 이벤트 탭 외의 탭이 잠긴다(lockTabsUntilCenter).
// ──────────────────────────────────────────────
const CENTER_SELECT_IDS = [
  "filter-center-event",        // ← 사용자가 실제로 조작하는 유일한 드롭다운
  "filter-center-excel",
  "filter-center-photo",
  "filter-center-report",
  "filter-center-report-insp",
];

/** 지금 조회 대상 센터. Master는 드롭다운 값(미선택이면 ""), 그 외는 항상 자기 센터. */
function currentCenter() {
  if (!currentUser) return "";
  if (currentUser.center_name !== "Master") return currentUser.center_name;
  for (const id of CENTER_SELECT_IDS) {
    const el = document.getElementById(id);
    if (el && el.value) return el.value;
  }
  return "";
}

/** 드롭다운 6개를 같은 값으로 맞춘다(어느 탭에서 골라도 나머지가 따라온다). */
function syncCenterSelects(value) {
  for (const id of CENTER_SELECT_IDS) {
    const el = document.getElementById(id);
    if (el && el.value !== value) el.value = value;
  }
}

/** 센터 미선택 안내를 목록 영역에 그린다. 조회를 시작하지 않았다는 뜻. */
function renderCenterPrompt(containerId, what = "데이터") {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="empty-state"><div class="icon">🏢</div>` +
    `<p>조회할 센터를 선택하세요.</p>` +
    `<p style="font-size:12px;color:var(--gray4)">센터를 고르면 ${esc(what)} 조회를 시작합니다.</p></div>`;
}

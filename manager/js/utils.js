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

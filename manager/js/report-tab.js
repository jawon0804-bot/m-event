// ──────────────────────────────────────────────
// 보고서 탭: 이벤트 / 점검표 서브탭 전환
// ──────────────────────────────────────────────
function reportSwitchSubTab(tab) {
  document.querySelectorAll('#page-report .sub-tab[data-reporttab]').forEach(el =>
    el.classList.toggle("active", el.dataset.reporttab === tab));
  const eventEl = document.getElementById("report-subpage-event");
  const inspEl  = document.getElementById("report-subpage-inspection");
  if (eventEl) eventEl.style.display = tab === "event" ? "block" : "none";
  if (inspEl)  inspEl.style.display  = tab === "inspection" ? "block" : "none";
  if (tab === "inspection") {
    const monthInput = document.getElementById("filter-month-report-insp");
    if (monthInput && !monthInput.value) monthInput.value = prevMonthStr();
  }
}

function prevMonthStr() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ──────────────────────────────────────────────
// 점검표 현황: Maxerve_Excel을 schedule_type/sheet_label 기준으로 월별 집계
// (center_configs 조인 없이 Maxerve_Excel 하나만 스캔 — 두 필드는 2026-07-25
//  배포 이후 생성된 문서부터 존재하므로, 그 이전 문서는 집계에서 빠짐)
// ──────────────────────────────────────────────
function setInspReportMsg(text, type) {
  const el = document.getElementById("report-insp-status-msg");
  el.textContent = text || "";
  el.className = "report-status-msg" + (type ? ` ${type}` : "");
}

async function loadInspectionReport() {
  const center = document.getElementById("filter-center-report-insp").value ||
    (currentUser.center_name !== "Master" ? currentUser.center_name : "");
  const month = document.getElementById("filter-month-report-insp").value;
  const btn   = document.getElementById("report-insp-load-btn");
  const card  = document.getElementById("report-insp-table-card");
  const tableEl = document.getElementById("report-insp-table");

  if (!center) { setInspReportMsg("센터를 선택하세요.", "error"); return; }
  if (!month)  { setInspReportMsg("월을 선택하세요.", "error"); return; }

  btn.disabled = true;
  setInspReportMsg("");
  card.style.display = "none";
  try {
    const snap = await db.collection("Maxerve_Excel")
      .where("center_name", "==", center)
      .where("datetime", ">=", month + "-01")
      .where("datetime", "<=", month + "-31\uffff")
      .get();

    if (snap.empty) {
      card.style.display = "block";
      tableEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>해당 월에 생성된 점검표가 없습니다.</p></div>`;
      return;
    }

    // (구분, 설비명) 조합별로 개수 집계
    const groups = {};
    let unclassified = 0;
    snap.forEach(doc => {
      const d = doc.data();
      const stype = d.schedule_type || "";
      const label = d.sheet_label || "";
      if (!stype || !label) { unclassified++; return; }
      const key = `${stype}|||${label}`;
      groups[key] = (groups[key] || 0) + 1;
    });

    const typeOrder = { daily: 0, weekly: 1, monthly: 2 };
    const rows = Object.entries(groups)
      .map(([key, count]) => {
        const [stype, label] = key.split("|||");
        return { stype, label, count };
      })
      .sort((a, b) => (typeOrder[a.stype] ?? 9) - (typeOrder[b.stype] ?? 9) || a.label.localeCompare(b.label));

    let html = `
      <table class="insp-report-table">
        <thead><tr><th>구분</th><th>설비명</th><th>개수</th></tr></thead>
        <tbody>
          ${rows.map(r => `<tr><td>${esc(r.stype)}</td><td>${esc(r.label)}</td><td>${r.count}</td></tr>`).join("")}
        </tbody>
      </table>`;
    if (unclassified) {
      html += `<div style="margin-top:8px;font-size:12px;color:var(--gray4)">⚠️ ${unclassified}건은 2026-07-25 이전 생성분이라 구분/설비명 정보가 없어 집계에서 제외됨</div>`;
    }
    card.style.display = "block";
    tableEl.innerHTML = html;
  } catch (e) {
    console.error("점검표 현황 조회 오류:", e);
    setInspReportMsg("조회 중 오류가 발생했습니다.", "error");
  } finally {
    btn.disabled = false;
  }
}

// ──────────────────────────────────────────────
// 보고서 탭 — 이벤트 엑셀 매핑(Callable: generateEventReport) / 다운로드(Callable: listEventReportFiles)
// 실제 xlsx 생성(사진 삽입 등)은 서버(Cloud Functions)에서만 하고, 프런트는 트리거+목록 표시만 담당
// ──────────────────────────────────────────────
function reportFilters() {
  return {
    center: document.getElementById("filter-center-report").value || "",
    status: document.getElementById("filter-status-report").value || "",
    start:  document.getElementById("filter-start-report").value || "",
    end:    document.getElementById("filter-end-report").value || "",
  };
}

function isOver1Year(start, end) {
  if (!start || !end) return false;
  return (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24) > 366;
}

function setReportMsg(text, type) {
  const el = document.getElementById("report-status-msg");
  el.textContent = text || "";
  el.className = "report-status-msg" + (type ? ` ${type}` : "");
}

async function mapEventReport() {
  const { center, status, start, end } = reportFilters();
  const btn = document.getElementById("report-map-btn");

  if (!start || !end) { setReportMsg("시작일과 종료일을 선택하세요.", "error"); return; }
  if (isOver1Year(start, end)) { setReportMsg("조회 기간은 최대 1년까지 가능합니다.", "error"); return; }

  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 매핑 중...`;
  setReportMsg("");
  try {
    const call = functions.httpsCallable("generateEventReport");
    const res  = await call({ center, status, start, end });
    const results = res.data.results || [];
    const done    = results.filter(r => r.fileName);
    const skipped = results.filter(r => r.skipped);
    const failed  = results.filter(r => r.error);

    let text = "";
    if (done.length)    text += `✅ ${done.length}개 센터 매핑 완료. `;
    if (skipped.length) text += `⏭ ${skipped.length}개 센터는 해당 기간에 이벤트 없음. `;
    if (failed.length)  text += `⚠️ ${failed.length}개 센터 실패.`;
    setReportMsg(text || "매핑이 완료되었습니다.", failed.length ? "error" : "success");

    // 매핑 직후 방금 만든 파일이 바로 보이게 목록도 갱신
    if (done.length) openReportFileList();
  } catch (e) {
    console.error("이벤트 보고서 매핑 오류:", e);
    setReportMsg((e.message || "").replace(/^[a-z-]+:\s*/i, "") || "매핑 중 오류가 발생했습니다.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-gears"></i> 매핑`;
  }
}

async function openReportFileList() {
  const center = document.getElementById("filter-center-report").value ||
    (currentUser.center_name !== "Master" ? currentUser.center_name : "");
  const card = document.getElementById("report-file-list-card");
  const listEl = document.getElementById("report-file-list");

  if (!center) {
    setReportMsg("파일 목록을 보려면 센터를 선택하세요.", "error");
    return;
  }
  card.style.display = "block";
  listEl.innerHTML = `<div class="report-file-loading">불러오는 중...</div>`;
  try {
    const call = functions.httpsCallable("listEventReportFiles");
    const res  = await call({ center });
    const files = res.data.files || [];
    if (files.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>생성된 파일이 없습니다.</p></div>`;
      return;
    }
    listEl.innerHTML = files.map(f => `
      <div class="report-file-item">
        <div class="excel-icon"><i class="fa-solid fa-file-excel" style="color:#217346;font-size:1.6rem;"></i></div>
        <div class="report-file-info">
          <div class="report-file-name">${esc(f.name)}</div>
          <div class="report-file-meta">${esc(fmtFileDate(f.updated))} · ${esc(fmtFileSize(f.size))}</div>
        </div>
        <a class="dl-btn" href="${esc(f.url)}" target="_blank" rel="noopener" download>⬇ 다운로드</a>
      </div>`).join("");
  } catch (e) {
    console.error("보고서 파일 목록 조회 오류:", e);
    listEl.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>파일 목록을 불러오지 못했습니다.</p></div>`;
  }
}

function fmtFileDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtFileSize(bytes) {
  if (!bytes) return "0KB";
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(0)}KB` : `${(kb / 1024).toFixed(1)}MB`;
}

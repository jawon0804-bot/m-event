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

// M-Engine의 lib/scheduler.py calc_expected_count()와 동일한 로직(JS 버전).
// daily=그 달 일수, monthly=1, weekly=그 달 월요일 수. 그 외/알 수 없는 값은 null.
function calcExpectedCount(scheduleType, year, month) {
  const daysInMonth = new Date(year, month, 0).getDate(); // month: 1~12
  if (scheduleType === "daily") return daysInMonth;
  if (scheduleType === "monthly") return 1;
  if (scheduleType === "weekly") {
    let count = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      if (new Date(year, month - 1, day).getDay() === 1) count++; // 1 = 월요일
    }
    return count;
  }
  return null;
}

// ──────────────────────────────────────────────
// 점검표 현황: center_configs/{center}/inspections(점검표 전체 목록) 기준으로
// 기대 횟수를 계산하고, Maxerve_Excel(facility_id 매칭)에서 실제 횟수를 세서
// 합침 — M-Engine의 월간 요약 메일(run_monthly_report)과 동일한 방식.
// facility_id는 2026-07-25 이전 문서에도 항상 있던 필드라, schedule_type/
// sheet_label이 없는 옛날 문서도 그대로 집계에 포함됨(별도 백필 불필요).
// 실제 생성 건수가 0인 점검표도 "기대 대비 부족"으로 표시됨(메일과 동일).
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
    const [year, monthNum] = month.split("-").map(Number);
    const inspectionsSnap = await db.collection("center_configs").doc(center).collection("inspections").get();
    if (inspectionsSnap.empty) {
      card.style.display = "block";
      tableEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>이 센터에 등록된 점검표가 없습니다.</p></div>`;
      return;
    }
    const snap = await db.collection("Maxerve_Excel")
      .where("center_name", "==", center)
      .where("datetime", ">=", month + "-01")
      .where("datetime", "<=", month + "-31\uffff")
      .get();

    // facility_id(합쳐진 문자열) 기준으로 실제 생성 건수 집계
    const actualByFid = {};
    snap.forEach(doc => {
      const fid = doc.data().facility_id || "";
      actualByFid[fid] = (actualByFid[fid] || 0) + 1;
    });

    const typeOrder = { daily: 0, weekly: 1, monthly: 2 };
    const rows = [];
    inspectionsSnap.forEach(doc => {
      const insp = doc.data();
      if (insp.active === false) return;
      const stype = insp.schedule_type || "";
      const expected = calcExpectedCount(stype, year, monthNum);
      if (expected === null) return; // daily/weekly/monthly 외 타입은 집계 대상 아님
      const label = insp.sheet_label || insp.func_key || doc.id;
      const fidStr = (Array.isArray(insp.fids) ? insp.fids : []).join(",");
      rows.push({ stype, label, count: actualByFid[fidStr] || 0, expected });
    });
    rows.sort((a, b) => (typeOrder[a.stype] ?? 9) - (typeOrder[b.stype] ?? 9) || a.label.localeCompare(b.label));

    if (rows.length === 0) {
      card.style.display = "block";
      tableEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>daily/weekly/monthly 점검표가 없습니다.</p></div>`;
      return;
    }

    const badge = (ok) => ok
      ? `<span style="background:#dcfce7;color:#15803d;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700;white-space:nowrap">정상</span>`
      : `<span style="background:#fee2e2;color:#dc2626;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700;white-space:nowrap">⚠️ 부족</span>`;

    const html = `
      <table class="insp-report-table">
        <thead><tr><th>구분</th><th>설비명</th><th>기대</th><th>실제</th><th>상태</th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const ok = r.count >= r.expected;
            return `<tr><td>${esc(r.stype)}</td><td>${esc(r.label)}</td><td>${r.expected}</td><td>${r.count}</td><td>${badge(ok)}</td></tr>`;
          }).join("")}
        </tbody>
      </table>`;
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

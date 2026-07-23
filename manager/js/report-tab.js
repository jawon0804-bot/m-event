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

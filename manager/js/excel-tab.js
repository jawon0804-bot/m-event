// ──────────────────────────────────────────────
// 엑셀 다운로드 URL 해석
//   ① file_url이 http(s) 절대 URL이면 그대로 사용
//   ② Storage 경로(gs:// 또는 상대 경로)만 저장돼 있으면 getDownloadURL로 변환
//   ③ 아무 값도 없으면 빈 문자열 반환 → 버튼 비활성화
//   ※ 기존에는 file_url이 비면 href="#"로 떨어져, target=_blank가 새 탭을
//     ".../#"로 열고 그 탭엔 sessionStorage(세션)가 없어 로그인 화면이 떴음.
//     (sessionStorage는 탭 단위라 새 탭엔 로그인 정보가 없음)
// ──────────────────────────────────────────────
async function resolveExcelUrl(item) {
  // 프로젝트마다 URL 필드명이 다를 수 있어 후보를 순서대로 탐색
  const raw = item.file_url || item.fileUrl || item.url || item.download_url || "";
  if (/^https?:\/\//i.test(raw)) return raw;      // 이미 다운로드 URL
  // http가 아니면 Storage 경로로 간주하고 변환 시도
  const path = raw || item.file_path || item.filePath || item.storage_path || item.storagePath || "";
  if (!path) return "";
  try {
    // gs:// 전체 경로면 refFromURL, 아니면 상대 경로 ref
    const ref = /^gs:\/\//i.test(path) ? storage.refFromURL(path) : storage.ref(path);
    return await ref.getDownloadURL();
  } catch (e) {
    console.warn("엑셀 다운로드 URL 변환 실패:", path, e.code || e);
    return "";
  }
}

// ──────────────────────────────────────────────
// 엑셀 로드
// ──────────────────────────────────────────────
async function loadExcel() {
  const center = document.getElementById("filter-center-excel").value || (currentUser.center_name !== "Master" ? currentUser.center_name : "");

  // Master가 센터 선택하면 해당 센터 sheetLabels 로드
  if (currentUser.center_name === "Master" && center) {
    await loadFidLocations(center);
  }
  const start  = document.getElementById("filter-start-excel").value;
  const end    = document.getElementById("filter-end-excel").value;

  // 90일 초과 체크
  if (isOver90Days(start, end)) {
    alert("조회 기간은 최대 90일까지 가능합니다.");
    return;
  }
  const el     = document.getElementById("excel-list");
  const sp     = document.getElementById("spinner-excel");
  el.innerHTML = ""; sp.classList.add("show");
  try {
    let q = db.collection("Maxerve_Excel").orderBy("datetime","desc");
    if (center) q = q.where("center_name","==",center);
    if (start)  q = q.where("datetime",">=",start);
    if (end)    q = q.where("datetime","<=",end+"\uffff");
    const snap = await q.get();
    sp.classList.remove("show");
    if (snap.empty) {
      el.innerHTML = `<div class="empty-state"><div class="icon"><i class="fa-solid fa-file-excel" style="color:#217346;font-size:2rem;"></i></div><p>해당 기간에 엑셀 파일이 없습니다.</p></div>`;
      renderPagination("pagination-excel", 0, 1, "goExcelPage");
      return;
    }

    // ── 페이지네이션: 문서(항목) 단위로 슬라이싱한 뒤 월별 그룹핑 ──
    const docs  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const total = docs.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (excelPage > totalPages) excelPage = totalPages;
    const paged = docs.slice((excelPage-1)*PAGE_SIZE, excelPage*PAGE_SIZE);

    // 페이지 항목들의 다운로드 URL을 병렬로 해석 (Storage 변환이 필요한 경우 대비)
    const resolved = await Promise.all(
      paged.map(async item => ({ item, url: await resolveExcelUrl(item) }))
    );

    const groups = {};
    resolved.forEach(row => {
      const dateKey = (row.item.datetime||"").slice(0,7);
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(row);
    });
    let html = "";
    Object.keys(groups).sort().reverse().forEach(month => {
      const [y,m] = month.split("-");
      html += `<div class="excel-group-header">📅 ${y}년 ${parseInt(m)}월 (${groups[month].length}건)</div>`;
      groups[month].forEach(({ item, url }) => {
        const f = (item.facility_id||"").split(",")[0].trim();
        const title = esc(sheetLabels[f]||fidLocations[f]||item.facility_id||"점검표");
        // URL이 있으면 다운로드 링크, 없으면 비활성 버튼(더 이상 href="#"로 새 탭을 열지 않음)
        const dlBtn = url
          ? `<a class="dl-btn" href="${esc(url)}" target="_blank" rel="noopener" download>⬇ 다운로드</a>`
          : `<span class="dl-btn" style="background:var(--gray3);cursor:not-allowed" title="다운로드 URL이 없습니다">파일 없음</span>`;
        html += `
        <div class="excel-item">
          <div class="excel-icon"><i class="fa-solid fa-file-excel" style="color:#217346;font-size:2rem;"></i></div>
          <div class="excel-info">
            <div class="excel-title">${title}</div>
            <div class="excel-meta">날짜: ${esc(item.datetime||"")}</div>
            <div class="excel-center">${esc(item.center_name||"")}</div>
          </div>
          ${dlBtn}
        </div>`;
      });
    });
    el.innerHTML = html;
    renderPagination("pagination-excel", total, excelPage, "goExcelPage");
  } catch(e) {
    sp.classList.remove("show");
    console.error(e);
    el.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>데이터를 불러오는 중 오류가 발생했습니다.</p></div>`;
  }
}
function goExcelPage(p) { excelPage = p; loadExcel(); window.scrollTo(0,0); }


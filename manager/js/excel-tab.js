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
// keepSelection: 페이지 이동(goExcelPage)처럼 "같은 조회 결과 안에서 화면만 바뀌는" 경우 true.
// 조회 버튼처럼 결과 자체가 바뀌는 경우엔 false(기본) — 사라진 문서가 선택에 남으면 안 되므로.
async function loadExcel(keepSelection = false) {
  // [2026-08-05] 센터 미선택이면 조회하지 않는다. 예전엔 Master가 "전체"면
  //   center_name 필터가 빠져 전 센터를 훑었다(아래 `if (center)` 참고).
  const center = currentCenter();
  if (!center) {
    document.getElementById("spinner-excel").classList.remove("show");
    excelDocs = [];
    excelSelectedIds.clear();
    syncExcelSelectionUI();
    renderPagination("pagination-excel", 0, 1, "goExcelPage");
    renderCenterPrompt("excel-list", "엑셀 파일 목록");
    return;
  }

  // Master가 센터 선택하면 해당 센터 sheetLabels 로드
  if (currentUser.center_name === "Master") {
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
    // center는 위 가드에서 보장된다 — 조건부로 두면 나중에 가드가 사라졌을 때
    // 필터 없이 전 센터를 훑는 쿼리로 조용히 되돌아간다.
    q = q.where("center_name","==",center);
    if (start)  q = q.where("datetime",">=",start);
    if (end)    q = q.where("datetime","<=",end+"\uffff");
    const snap = await q.get();
    sp.classList.remove("show");
    if (snap.empty) {
      excelDocs = [];
      excelSelectedIds.clear();
      syncExcelSelectionUI();
      el.innerHTML = `<div class="empty-state"><div class="icon"><i class="fa-solid fa-file-excel" style="color:#217346;font-size:2rem;"></i></div><p>해당 기간에 엑셀 파일이 없습니다.</p></div>`;
      renderPagination("pagination-excel", 0, 1, "goExcelPage");
      return;
    }

    // ── 페이지네이션: 문서(항목) 단위로 슬라이싱한 뒤 월별 그룹핑 ──
    const docs  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const total = docs.length;

    // 조회 결과 전체를 들고 있어야 "전체 선택"이 현재 페이지가 아닌 전부를 대상으로 할 수 있다.
    excelDocs = docs;
    if (!keepSelection) {
      excelSelectedIds.clear();
      setExcelMergeMsg("");
    } else {
      // 페이지 이동이라 선택은 유지하되, 결과에서 사라진 ID는 정리한다
      const alive = new Set(docs.map(d => d.id));
      excelSelectedIds.forEach(id => { if (!alive.has(id)) excelSelectedIds.delete(id); });
    }
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
        const checked = excelSelectedIds.has(item.id);
        html += `
        <div class="excel-item${checked ? " selected" : ""}" data-id="${esc(item.id)}">
          <input type="checkbox" class="excel-item-check" ${checked ? "checked" : ""}
                 onchange="toggleExcelItem('${esc(item.id)}', this.checked)"
                 aria-label="${title} 병합 대상 선택">
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
    syncExcelSelectionUI();
  } catch(e) {
    sp.classList.remove("show");
    console.error(e);
    el.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>데이터를 불러오는 중 오류가 발생했습니다.</p></div>`;
  }
}
// 페이지 이동은 같은 조회 결과 안에서 화면만 바뀌는 것 — 선택을 유지한다
function goExcelPage(p) { excelPage = p; loadExcel(true); window.scrollTo(0,0); }

// ──────────────────────────────────────────────
// 파일 병합 — 체크한 점검표를 시트별로 합친 엑셀 1개로 받기
//
// 실제 병합은 서버(Cloud Functions: mergeExcelFiles)에서만 한다. 이 페이지에 SheetJS가
// 로드돼 있어서 브라우저에서도 합칠 수는 있지만, 무료판은 읽은 서식을 다시 쓰지 못해
// 테두리/색/로고가 전부 날아간 맨 격자가 나오기 때문 (functions/lib/excel-merge.js 참고).
//
// 프런트는 선택 관리 + 트리거 + 결과 안내만 담당한다 (보고서 탭 mapEventReport와 같은 구조).
// 선택은 문서 ID로만 서버에 보내고, 서버가 그 ID의 센터를 다시 확인한다.
// ──────────────────────────────────────────────
function setExcelMergeMsg(text, type) {
  const el = document.getElementById("excel-merge-msg");
  el.textContent = text || "";
  el.className = "excel-merge-msg" + (type ? ` ${type}` : "");
}

// 선택 상태 → 화면(전체선택 체크박스/건수/버튼)에 반영.
// 목록을 다시 그릴 때와 개별 체크가 바뀔 때 모두 여기를 통해 갱신한다.
function syncExcelSelectionUI() {
  const bar     = document.getElementById("excel-select-bar");
  const all     = document.getElementById("excel-check-all");
  const allLbl  = document.getElementById("excel-check-all-label");
  const countEl = document.getElementById("excel-select-count");
  const clearBtn= document.getElementById("excel-clear-btn");
  const btn     = document.getElementById("excel-merge-btn");

  const total    = excelDocs.length;
  const selected = excelSelectedIds.size;

  bar.style.display = total > 0 ? "flex" : "none";

  // "전체 선택"은 현재 페이지가 아니라 조회 결과 전체가 대상이라, 건수를 같이 적어 오해를 막는다
  allLbl.textContent = `전체 선택 (${total}건)`;
  all.checked = total > 0 && selected === total;
  all.indeterminate = selected > 0 && selected < total;

  countEl.textContent = selected > 0 ? `${selected}건 선택됨` : "";
  clearBtn.disabled = selected === 0;

  btn.disabled = selected === 0;
  btn.innerHTML = selected > 0
    ? `<i class="fa-solid fa-layer-group"></i> 파일 병합 (${selected}건)`
    : `<i class="fa-solid fa-layer-group"></i> 파일 병합`;

  // 현재 페이지에 그려진 행들의 체크 상태/강조도 맞춰준다
  document.querySelectorAll("#excel-list .excel-item").forEach(row => {
    const on = excelSelectedIds.has(row.dataset.id);
    row.classList.toggle("selected", on);
    const cb = row.querySelector(".excel-item-check");
    if (cb) cb.checked = on;
  });
}

function toggleExcelItem(id, checked) {
  if (checked) excelSelectedIds.add(id); else excelSelectedIds.delete(id);
  syncExcelSelectionUI();
}

// 조회 결과 전체를 선택/해제 (현재 페이지에 안 보이는 항목까지 포함)
function toggleAllExcel(checked) {
  excelSelectedIds.clear();
  if (checked) excelDocs.forEach(d => excelSelectedIds.add(d.id));
  syncExcelSelectionUI();
}

function clearExcelSelection() {
  excelSelectedIds.clear();
  syncExcelSelectionUI();
}

async function mergeSelectedExcel() {
  const center = document.getElementById("filter-center-excel").value ||
    (currentUser.center_name !== "Master" ? currentUser.center_name : "");
  const start  = document.getElementById("filter-start-excel").value;
  const end    = document.getElementById("filter-end-excel").value;
  const btn    = document.getElementById("excel-merge-btn");

  // 센터별로 점검표 양식이 달라서 한 파일에 섞으면 오히려 보기 나쁘다 —
  // Master가 센터를 "전체"로 둔 경우엔 고르도록 안내한다 (서버에서도 동일하게 막고 있음)
  if (!center) { setExcelMergeMsg("파일 병합은 센터를 선택해야 합니다.", "error"); return; }
  if (excelSelectedIds.size === 0) { setExcelMergeMsg("합칠 점검표를 선택해주세요.", "error"); return; }

  // 화면 목록 순서(최신순) 그대로 보내서 시트 순서가 목록과 같아지게 한다
  const ids = excelDocs.map(d => d.id).filter(id => excelSelectedIds.has(id));

  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 병합 중...`;
  setExcelMergeMsg(`${ids.length}건을 합치고 있습니다. 건수가 많으면 1~2분 걸릴 수 있습니다.`);
  try {
    const call = functions.httpsCallable("mergeExcelFiles");
    const { data } = await call({ center, start, end, ids });

    // 서명 URL(10분)로 바로 저장 — 새 탭을 열지 않으므로 sessionStorage 로그인 이슈가 없다
    // (개별 다운로드 버튼이 target=_blank로 겪었던 문제, 이 파일 위쪽 주석 참고)
    const a = document.createElement("a");
    a.href = data.url;
    a.download = data.fileName || "병합.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();

    let text = `✅ ${data.merged}개 점검표를 시트별로 합쳤습니다.`;
    let type = "success";
    if (data.missing) {
      text += ` ${data.missing}건은 목록에서 찾을 수 없어 빠졌습니다 — 조회를 다시 해주세요.`;
      type = "warn";
    }
    if (data.strippedImages) {
      text += ` (${data.strippedImages}개 시트는 원본 그림을 옮기지 못해 표/데이터만 들어갔습니다.)`;
    }
    if (data.failures && data.failures.length) {
      const names = data.failures.slice(0, 3).map(f => `${f.datetime} ${f.label}`).join(", ");
      text += ` ⚠️ ${data.failures.length}건은 원본을 못 읽어 제외됐습니다 (${names}${data.failures.length > 3 ? " 외" : ""}).`;
      type = "warn";
    }
    setExcelMergeMsg(text, type);
  } catch (e) {
    console.error("엑셀 파일 병합 오류:", e);
    // Callable 에러 메시지 앞에 붙는 "invalid-argument: " 같은 코드 접두사를 떼고 보여줌
    setExcelMergeMsg(
      (e.message || "").replace(/^[a-z-]+:\s*/i, "") || "병합 중 오류가 발생했습니다.",
      "error"
    );
  } finally {
    // 버튼 활성화/라벨(선택 건수 포함)은 전부 여기서 복원된다 — 성공/실패 공통
    syncExcelSelectionUI();
  }
}


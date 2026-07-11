// ──────────────────────────────────────────────
// 사진 로드
// ──────────────────────────────────────────────
async function loadDashPhotos() {
  const center = document.getElementById("filter-center-photo").value || (currentUser.center_name !== "Master" ? currentUser.center_name : "");

  // Master가 센터 선택하면 해당 센터 sheetLabels 로드
  if (currentUser.center_name === "Master" && center) {
    await loadFidLocations(center);
  }
  const start  = document.getElementById("filter-start-photo").value;
  const end    = document.getElementById("filter-end-photo").value;

  // 90일 초과 체크
  if (isOver90Days(start, end)) {
    alert("조회 기간은 최대 90일까지 가능합니다.");
    return;
  }
  const el     = document.getElementById("photo-list");
  const sp     = document.getElementById("spinner-photo");
  el.innerHTML = ""; sp.classList.add("show");
  try {
    // 날짜 필터를 서버 사이드로 이동 — 전체 로그를 받아오지 않아 읽기 비용/속도 개선
    // (center + datetime 복합 색인 필요 시 콘솔 에러의 링크로 생성)
    let q = db.collection("inspection_logs").orderBy("datetime","desc");
    if (center) q = q.where("center_name","==",center);
    if (start)  q = q.where("datetime",">=",start);
    if (end)    q = q.where("datetime","<=",end+"\uffff");
    const snap = await q.get();

    // photo_count 필터만 클라이언트 사이드 유지 (문자열/숫자 혼재 가능성 때문)
    const filtered = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(item => toCount(item.photo_count) > 0);

    sp.classList.remove("show");
    if (filtered.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="icon">📷</div><p>해당 기간에 사진이 없습니다.</p></div>`;
      renderPagination("pagination-photo", 0, 1, "goPhotoPage");
      return;
    }

    // ── 페이지네이션: 로그 항목 단위로 슬라이싱한 뒤 일자별 그룹핑 ──
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (photoPage > totalPages) photoPage = totalPages;
    const paged = filtered.slice((photoPage-1)*PAGE_SIZE, photoPage*PAGE_SIZE);

    const groups = {};
    paged.forEach(item => {
      const dateKey = (item.datetime||"").slice(0,10);
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(item);
    });
    let html = "";
    Object.keys(groups).sort().reverse().forEach(date => {
      const items       = groups[date];
      const totalPhotos = items.reduce((s,i) => s + toCount(i.photo_count), 0);
      html += `
        <div class="photo-group-header">
          <span>📅 ${esc(date)} (${items.length}건 · 사진 ${totalPhotos}장)</span>
          <span style="font-size:12px;color:var(--gray4)">${esc(items[0]?.center_name||"")}</span>
        </div>
        <div class="photo-group-body">
          <div class="photo-grid-dash" data-date="${esc(date)}">
            <div style="color:var(--gray3);font-size:13px;display:flex;align-items:center;gap:8px">
              <div style="width:32px;height:32px;border:3px solid var(--gray2);border-top-color:var(--navy);border-radius:50%;animation:spin .8s linear infinite"></div>로드 중...
            </div>
          </div>
        </div>`;
    });
    el.innerHTML = html;
    renderPagination("pagination-photo", total, photoPage, "goPhotoPage");
    for (const [date, items] of Object.entries(groups)) loadPhotoGroup(date, items);
  } catch(e) {
    sp.classList.remove("show");
    console.error(e);
    el.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>오류가 발생했습니다.</p></div>`;
  }
}

async function loadPhotoGroup(date, items) {
  const grid = document.querySelector(`.photo-grid-dash[data-date="${CSS.escape(date)}"]`);
  if (!grid) return;

  // getDownloadURL 순차 await → 병렬(allSettled)로 변경: N장 × RTT → 약 1 RTT
  const tasks = [];
  for (const item of items) {
    const count      = toCount(item.photo_count);
    const facilityId = (item.facility_id||"").replace(/\s/g,"_");
    const dt         = (item.datetime||"").replace(/[-: ]/g,"").slice(0,12);
    for (let i = 1; i <= Math.min(count,3); i++) {
      const fileName = `${dt.slice(0,8)}_${dt.slice(8,12)}_${facilityId}_${i}.jpg`;
      tasks.push(
        storage.ref(`inspection_photos/${item.center_name}/${fileName}`).getDownloadURL()
          .then(url => ({ url, fileName, facilityKey: facilityId,
                          facilityId: item.facility_id,
                          fid_name: item.fid_name||item.facility_id,
                          datetime: item.datetime }))
          .catch(e => {
            if (e.code !== "storage/object-not-found") console.warn(fileName, e.code);
            return null;
          })
      );
    }
  }
  const cards = (await Promise.all(tasks)).filter(Boolean);

  if (cards.length === 0) { grid.innerHTML = `<div style="color:var(--gray3);font-size:13px">사진을 불러올 수 없습니다.</div>`; return; }
  grid.innerHTML = cards.map((c, idx) => `
    <div class="photo-card">
      <img class="photo-thumb-dash" data-idx="${idx}" src="${esc(c.url)}" alt="${esc(c.fid_name||c.facilityId)}"
           onerror="this.style.display='none'">
      <div style="flex:1;min-width:0;">
        <div class="photo-facility">${esc(sheetLabels[c.facilityKey]||fidLocations[c.facilityKey]||c.fid_name||c.facilityId)}</div>
        <div class="photo-name">${esc(c.datetime||"")}</div>
      </div>
      <a class="photo-dl" href="${esc(c.url)}" download="${esc(c.fileName)}" target="_blank" rel="noopener">⬇ 다운로드</a>
    </div>`).join("");
  // 인라인 onclick 문자열 조립 제거 → 리스너 + 클로저로 데이터 전달 (XSS 원천 차단)
  grid.querySelectorAll(".photo-thumb-dash").forEach(img => {
    const c = cards[Number(img.dataset.idx)];
    img.addEventListener("click", () => openViewer(c.url, c.fileName, c.fid_name || c.facilityId));
  });
}

function goPhotoPage(p) { photoPage = p; loadDashPhotos(); window.scrollTo(0,0); }

function openViewer(url, fileName, facilityId) {
  document.getElementById("viewer-img").src     = url;
  document.getElementById("viewer-dl").href     = url;
  document.getElementById("viewer-dl").download = fileName;
  document.getElementById("viewer-info").textContent = `${facilityId} · ${fileName}`;
  document.getElementById("viewer").classList.add("open");
}
function handleViewerClick(e) { if (e.target===document.getElementById("viewer")) closeViewer(); }
function closeViewer() {
  document.getElementById("viewer").classList.remove("open");
  document.getElementById("viewer-img").src = "";
}


// ──────────────────────────────────────────────
// 이벤트 탭
// ──────────────────────────────────────────────
function subscribeEvents() {
  if (unsubscribe) unsubscribe();

  // 90일 전 날짜 계산
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const cutoff = firebase.firestore.Timestamp.fromDate(ninetyDaysAgo);

  const selectedCenter = document.getElementById("filter-center-event")?.value || "";

  // Master가 센터 선택하면 해당 센터 sheetLabels 로드 후 재렌더링
  if (currentUser.center_name === "Master" && selectedCenter) {
    loadFidLocations(selectedCenter).then(() => renderList());
  }

  let q = db.collection("events")
    .orderBy("created_at", "desc")
    .where("created_at", ">=", cutoff);

  if (currentUser.center_name !== "Master") {
    q = q.where("center_name", "==", currentUser.center_name);
  } else if (selectedCenter) {
    q = q.where("center_name", "==", selectedCenter);
  }

  unsubscribe = q.onSnapshot(snap => {
    allEvents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderList();
    updateBadge();
  }, e => {
    console.error("이벤트 구독 오류:", e);
    document.getElementById("event-list").innerHTML =
      `<div class="empty-state"><div class="icon">⚠️</div><p>이벤트를 불러오는 중 오류가 발생했습니다.</p></div>`;
  });
}

function switchEventTab(tab) {
  eventTab = tab;
  eventPage = 1; // 탭 전환 시 페이지 리셋
  document.querySelectorAll(".sub-tab").forEach(el =>
    el.classList.toggle("active", el.dataset.tab === tab));
  renderList();
}

function renderList() {
  const keyword  = document.getElementById("search-input").value.toLowerCase();
  const isActive = eventTab === "진행중";
  const filtered = allEvents.filter(ev => {
    const matchTab = isActive ? ev.status !== "완료" : ev.status === "완료";
    if (!matchTab) return false;
    if (!keyword) return true;
    const firstFid = (ev.facility_id||"").split(",")[0].trim();
    const fidLabel = sheetLabels[firstFid] || "";
    return [ev.memo, ev.facility_id, ev.fid_name, fidLabel, ev.worker, ev.center_name]
      .some(v => (v||"").toLowerCase().includes(keyword));
  });
  const el = document.getElementById("event-list");
  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="icon">${isActive ? "✅" : "📭"}</div>
      <p>${isActive ? "진행 중인 이벤트가 없습니다." : "완료된 이벤트가 없습니다."}</p>
    </div>`;
    renderPagination("pagination-event", 0, 1, "goEventPage");
    return;
  }
  const total = filtered.length;
  // 필터/검색 변경으로 총 페이지가 줄었을 때 현재 페이지 범위 보정
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (eventPage > totalPages) eventPage = totalPages;

  const paged = filtered.slice((eventPage-1)*PAGE_SIZE, eventPage*PAGE_SIZE);
  el.innerHTML = paged.map(ev => {
    const lastAction = (ev.history||[]).slice(-1)[0];
    const photoCount = toCount(ev.photo_count);
    return `
    <div class="event-item" data-event-id="${esc(ev.id)}">
      <div class="status-dot ${ev.status}"></div>
      <div class="event-meta">
        <div class="event-center">${esc(ev.center_name||"")}</div>
        <div class="event-facility">${esc(ev.fid_name||ev.facility_id||"")}</div>
      </div>
      <div class="event-body">
        <div class="event-memo">${esc(ev.memo||"")}</div>
        ${lastAction && lastAction.type !== "발생" ? `<div class="event-preview">↳ ${esc(lastAction.content||"")}</div>` : ""}
        ${photoCount > 0 ? `<div class="has-photo">📷 사진 ${photoCount}장</div>` : ""}
      </div>
      <div class="event-right">
        <div class="event-date">${fmtDate(ev.created_at)}</div>
        <div class="event-worker">${esc(ev.worker||"")}</div>
        <span class="status-badge ${ev.status}">${ev.status}</span>
      </div>
    </div>`;
  }).join("");
  // 인라인 onclick 대신 리스너 연결 (문자열 조립을 통한 데이터 주입 차단)
  el.querySelectorAll(".event-item").forEach(item => {
    item.addEventListener("click", () => openModal(item.dataset.eventId));
  });
  renderPagination("pagination-event", total, eventPage, "goEventPage");
}
function goEventPage(p) { eventPage = p; renderList(); window.scrollTo(0,0); }

function updateBadge() {
  const count = allEvents.filter(e => e.status !== "완료").length;
  document.getElementById("badge-active").textContent  = count;
  document.getElementById("badge-active2").textContent = count;
}

// ──────────────────────────────────────────────
// 이벤트 팝업
// ──────────────────────────────────────────────
function openModal(eventId) {
  currentEvent = allEvents.find(e => e.id === eventId);
  if (!currentEvent) return;
  const isDone = currentEvent.status === "완료";
  document.getElementById("modal-dot").className        = `status-dot ${currentEvent.status}`;
  document.getElementById("modal-title-text").textContent = currentEvent.memo || "";
  document.getElementById("m-center").textContent       = currentEvent.center_name  || "";
  document.getElementById("m-facility").textContent     = currentEvent.fid_name || currentEvent.facility_id  || "";
  document.getElementById("m-worker").textContent       = currentEvent.worker        || "";
  document.getElementById("m-datetime").textContent     = currentEvent.datetime      || "";
  loadEventPhotos(currentEvent);
  const icons   = { "발생":"🔴","조치중":"🟡","완료":"🟢" };
  const history = currentEvent.history || [];
  document.getElementById("modal-timeline").innerHTML = history.map((h,i) => `
    <div class="timeline-item">
      <div class="t-left">
        <div class="t-icon ${h.type}">${icons[h.type]||"⚪"}</div>
        ${i < history.length-1 ? '<div class="t-line"></div>' : ""}
      </div>
      <div class="t-body">
        <div class="t-header">
          <span class="t-type ${h.type}">${h.type}</span>
          <span class="t-by">${esc(h.by||"")}</span>
          <span class="t-at">${fmtDate(h.at)}</span>
        </div>
        <div class="t-text">${esc(h.content||"")}</div>
      </div>
    </div>`).join("");
  document.getElementById("modal-action").innerHTML = isDone
    ? `<div class="completed-msg">🟢 이 이벤트는 완료 처리되었습니다.</div>`
    : `<textarea id="action-text" placeholder="조치사항 또는 완료 내용을 입력하세요..."></textarea>
       <div class="action-btns">
         <button class="btn btn-action" onclick="submitAction('조치중')">🟡 조치 진행</button>
         <button class="btn btn-done"   onclick="submitAction('완료')">🟢 완료 처리</button>
       </div>`;
  document.getElementById("modal-overlay").classList.add("open");
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById("modal-overlay")) closeModal();
}
function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  currentEvent = null;
}

async function submitAction(type) {
  const content = (document.getElementById("action-text")?.value||"").trim();
  if (!content) { alert("내용을 입력하세요."); return; }
  if (!currentEvent) return;
  try {
    await db.collection("events").doc(currentEvent.id).update({
      status:           type,
      history:          firebase.firestore.FieldValue.arrayUnion({
        type, content, by: currentUser.name||"", at: firebase.firestore.Timestamp.now(),
      }),
      last_notified_at: firebase.firestore.Timestamp.now(),
      updated_at:       firebase.firestore.FieldValue.serverTimestamp(),
      ...(type==="완료" ? { completed_at: firebase.firestore.FieldValue.serverTimestamp() } : {}),
    });
    closeModal();
  } catch(e) {
    console.error("조치 처리 오류:", e);
    alert("처리 중 오류가 발생했습니다.");
  }
}

async function loadEventPhotos(ev) {
  const grid = document.getElementById("photo-grid");
  const sec  = document.getElementById("photo-section");

  // 렌더링 + 리스너 연결 공통 함수 (인라인 onclick 제거)
  const renderThumbs = (cards) => {
    grid.innerHTML = cards.map((c, idx) => `
      <div>
        <img class="photo-thumb" data-idx="${idx}" src="${esc(c.url)}" alt="${esc(c.label||"사진")}"
             ${c.fileName ? `title="${esc(c.fileName)}"` : ""}>
        ${c.label ? `<div style="font-size:11px;color:var(--gray4);text-align:center;margin-top:4px">${esc(c.label)}</div>` : ""}
      </div>`).join("");
    grid.querySelectorAll(".photo-thumb").forEach(img => {
      img.addEventListener("click", () => openEventViewer(cards[Number(img.dataset.idx)].url));
    });
  };

  // ① events에 photos URL이 있으면 바로 사용
  const photoUrls = (ev.photos || "").split(",").map(s => s.trim()).filter(Boolean);
  if (photoUrls.length > 0) {
    sec.style.display = "block";
    renderThumbs(photoUrls.map(url => ({ url })));
    return;
  }

  // ② photos URL 없으면 파일명 패턴으로 Storage에서 조회 (병렬 처리)
  const count = toCount(ev.photo_count);
  if (count === 0) { sec.style.display = "none"; return; }
  sec.style.display = "block";
  grid.innerHTML = `<div class="photo-loading"><div style="width:32px;height:32px;border:3px solid var(--gray2);border-top-color:var(--navy);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;margin-right:8px;vertical-align:middle"></div>사진 불러오는 중...</div>`;
  const dt         = (ev.datetime||"").replace(/[-: ]/g,"").slice(0,12);
  const facilityId = (ev.facility_id||"").replace(/\s/g,"_");

  const tasks = [];
  for (let i = 1; i <= Math.min(count,3); i++) {
    const fileName = `${dt.slice(0,8)}_${dt.slice(8,12)}_${facilityId}_${i}.jpg`;
    tasks.push(
      storage.ref(`inspection_photos/${ev.center_name}/${fileName}`).getDownloadURL()
        .then(url => ({ url, fileName, label: ev.facility_id }))
    );
  }
  // allSettled: 일부 파일이 없어도 나머지는 표시 (기존 동작 유지)
  const results = await Promise.allSettled(tasks);
  const urls = results.filter(r => r.status === "fulfilled").map(r => r.value);
  results.filter(r => r.status === "rejected").forEach(r => console.warn("사진 로드 실패:", r.reason?.code || r.reason));

  if (urls.length === 0) { grid.innerHTML = `<div class="no-photo">사진을 불러올 수 없습니다.</div>`; return; }
  renderThumbs(urls);
}

function openEventViewer(url) {
  document.getElementById("event-viewer-img").src = url;
  const v = document.getElementById("photo-viewer");
  v.style.display = "flex";
}
function closeEventViewer() {
  document.getElementById("photo-viewer").style.display = "none";
  document.getElementById("event-viewer-img").src = "";
}


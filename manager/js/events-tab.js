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

  // [2026-08-05] 센터를 고르기 전에는 구독하지 않는다.
  //   예전엔 Master가 미선택이면 center_name 필터 없이 **전 센터 90일치**를 실시간
  //   구독했다. 센터가 늘수록 그 구독만 무거워진다(50곳이면 수천~1만 건을 브라우저가
  //   들고 매 변경마다 리렌더). 지금은 고른 센터 하나만 구독한다.
  const center = currentUser.center_name !== "Master" ? currentUser.center_name : selectedCenter;
  if (!center) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    allEvents = [];
    updateBadge();
    renderCenterPrompt("event-list", "이벤트 목록");
    return;
  }

  const q = db.collection("events")
    .orderBy("created_at", "desc")
    .where("created_at", ">=", cutoff)
    .where("center_name", "==", center);

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
  clearPendingDonePhotos(); // 이전 팝업에서 고르고 안 올린 사진이 넘어오지 않게
  const isDone = currentEvent.status === "완료";
  document.getElementById("modal-dot").className        = `status-dot ${currentEvent.status}`;
  document.getElementById("modal-title-text").textContent = currentEvent.memo || "";
  document.getElementById("m-center").textContent       = currentEvent.center_name  || "";
  document.getElementById("m-facility").textContent     = currentEvent.fid_name || currentEvent.facility_id  || "";
  document.getElementById("m-worker").textContent       = currentEvent.worker        || "";
  document.getElementById("m-datetime").textContent     = currentEvent.datetime      || "";
  loadEventPhotos(currentEvent);
  renderDonePhotos(currentEvent);
  // "조치중"은 2026-08-14에 "진행중"으로 이름이 바뀌었지만, 그 전에 쌓인 history 항목엔
  // 옛 이름이 그대로 남아 있다(이력은 지난 기록이라 고치지 않는다) — 둘 다 받아준다.
  const icons   = { "발생":"🔴","진행중":"🟡","조치중":"🟡","완료":"🟢" };
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
         <button class="btn btn-action" onclick="submitAction('진행중')">🟡 조치 진행</button>
         <button class="btn btn-done"   onclick="submitAction('완료')">🟢 완료 처리</button>
       </div>`;
  // 완료 사진 첨부 버튼은 위 renderDonePhotos가 그린다 — 완료 전에는 대기 목록에 담고
  // [완료 처리]를 누를 때 함께 올라간다.
  document.getElementById("modal-overlay").classList.add("open");
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById("modal-overlay")) closeModal();
}
function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  clearPendingDonePhotos();
  currentEvent = null;
}

async function submitAction(type) {
  const content = (document.getElementById("action-text")?.value||"").trim();
  if (!content) { alert("내용을 입력하세요."); return; }
  if (!currentEvent) return;

  // 완료 사진은 완료 처리에만 붙는다. 첨부해 놓고 [조치 진행]을 누르면 그대로 사라지므로
  // 조용히 버리지 않고 한 번 물어본다.
  if (type !== "완료" && pendingDonePhotos.length > 0 &&
      !confirm("첨부한 완료 사진은 [완료 처리]할 때만 저장됩니다. 사진 없이 진행할까요?")) return;

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

    // 완료 처리와 함께 첨부한 사진 올리기.
    // ⚠️ 실패해도 완료 처리는 되돌리지 않는다 — 사진 때문에 업무 흐름이 막히는 쪽이 더 나쁘다.
    //   못 올린 건 완료 팝업을 다시 열어 [완료 사진 첨부]로 올리면 된다.
    if (type === "완료" && pendingDonePhotos.length > 0) {
      const ev = currentEvent;
      const startIndex = (ev.completion_photos || []).length;
      try {
        const urls = await uploadDonePhotos(ev, pendingDonePhotos.map(p => p.blob), startIndex);
        await saveDonePhotoUrls(ev, urls, startIndex);
      } catch (e) {
        console.error("완료사진 업로드 오류:", e);
        alert("완료 처리는 되었지만 사진 업로드에 실패했습니다.\n완료 탭에서 다시 첨부해주세요.");
      }
    }
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
  // [2026-07-29 수정] 파일을 실제로 쓰는 M-SMART(public/js/submit.js)의 cleanFid와 동일 규칙.
  // 예전엔 공백을 밑줄로 바꿨는데(`/\s/g,"_"`) M-SMART는 지운다 — 설비ID에 공백/특수문자가
  // 있으면 실제 파일명과 어긋나 사진을 못 찾았다. photo-tab.js·report-export.js·
  // Dashboard lib/photoNaming.js와 항상 같이 유지할 것.
  const facilityId = (ev.facility_id||"").replace(/[/\\?%*:|"<>\s]/g,"");

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

// ──────────────────────────────────────────────
// 완료 사진 — 관리자가 올리는 완료 증빙. 이벤트 보고서의 완료사진1·2(J·K열)로 나간다.
// [2026-08-14 신규]
//
// 파일명을 나중에 추정하지 않는다: 업로드 직후 받은 다운로드 URL을 events 문서의
// completion_photos에 저장하고, 화면도 보고서도 그 URL만 쓴다. 점검 사진은 파일명 규칙을
// 다섯 곳에서 각자 추정하다 서로 어긋난 이력이 있어서(system_map.md 4번), 새로 만드는
// 경로에서는 추정 자체를 없앴다.
// ──────────────────────────────────────────────
const MAX_DONE_PHOTOS      = 2;    // 보고서 완료사진 열이 2개다
const DONE_PHOTO_MAX_WIDTH = 1600; // 아래 압축 규칙은 M-SMART public/js/photo.js와 같은 값
const DONE_PHOTO_QUALITY   = 0.85;

// 완료 처리와 동시에 올릴 사진 (아직 업로드 전). 모달을 닫으면 비운다.
let pendingDonePhotos = [];

// 파일 → 캔버스로 축소 → JPEG Blob. 1600px/85%면 장당 300~400KB로, 판독에 필요한
// 해상도는 남기면서 업로드가 빠르다 (M-SMART가 2400px에서 되돌린 값과 같은 근거).
function compressToJpeg(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error("이미지 파일이 아닙니다."));
      img.onload = () => {
        let width = img.width, height = img.height;
        if (width > DONE_PHOTO_MAX_WIDTH) { height *= DONE_PHOTO_MAX_WIDTH / width; width = DONE_PHOTO_MAX_WIDTH; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          blob => blob ? resolve(blob) : reject(new Error("이미지 변환에 실패했습니다.")),
          "image/jpeg", DONE_PHOTO_QUALITY);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// 파일 선택창을 열어 압축된 Blob 배열을 돌려준다 (최대 limit장).
// 취소하면 change 이벤트가 안 와서 resolve되지 않는데, 호출부가 그 전에 UI를 잠그지
// 않으므로 그대로 둔다 — 취소 시 아무 일도 일어나지 않는 게 맞다.
function pickPhotoBlobs(limit) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = limit > 1;
    input.onchange = async e => {
      const files = Array.from(e.target.files || []).slice(0, limit);
      const blobs = [];
      for (const f of files) {
        try { blobs.push(await compressToJpeg(f)); }
        catch (err) { console.warn("완료사진 압축 실패:", f.name, err); alert(`${f.name}: ${err.message}`); }
      }
      resolve(blobs);
    };
    input.click();
  });
}

// ⚠️ 업로드는 반드시 이 함수 하나를 거칠 것 — put()과 URL 저장을 쪼개면 안 된다.
//   같은 경로에 덮어쓰면 GCS가 객체 메타데이터를 **병합이 아니라 교체**해서 Firebase
//   다운로드 토큰(URL 끝의 ?token=...)이 새로 발급된다. 즉 **이전 URL은 그 순간 죽는다.**
//   파일만 바꾸고 문서의 옛 URL을 그대로 두면 화면·보고서 양쪽에서 깨진 이미지가 된다.
//   put() → getDownloadURL() → 문서 갱신을 한 묶음으로 유지할 것.
async function uploadDonePhotos(ev, blobs, startIndex) {
  const urls = [];
  for (let i = 0; i < blobs.length; i++) {
    const slot = startIndex + i + 1; // 1-based. 파일명이자 보고서 J·K 순서
    const ref = storage.ref(`completion_photos/${ev.center_name}/${ev.id}_${slot}.jpg`);
    await ref.put(blobs[i], { contentType: "image/jpeg" });
    urls.push(await ref.getDownloadURL()); // 덮어쓴 경우 여기서 새 토큰이 붙은 URL이 나온다
  }
  return urls;
}

// 업로드된 URL을 문서에 반영. 자리(slot) 단위로 덮어써서 교체가 자연스럽게 되도록 한다.
async function saveDonePhotoUrls(ev, urls, startIndex) {
  const next = [...(ev.completion_photos || [])];
  urls.forEach((u, i) => { next[startIndex + i] = u; });
  const merged = next.slice(0, MAX_DONE_PHOTOS);
  await db.collection("events").doc(ev.id).update({
    completion_photos: merged,
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  });
  ev.completion_photos = merged; // 화면 즉시 반영 (onSnapshot이 뒤이어 갱신한다)
  return merged;
}

function setDonePhotoMsg(text, isError) {
  const el = document.getElementById("done-photo-msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "done-photo-msg" + (isError ? " error" : "");
}

// 완료된 이벤트 팝업에서: 고르는 즉시 업로드한다 (붙일 문서가 이미 완료 상태라 대기할 이유가 없다)
async function attachDonePhotos(replace) {
  if (!currentEvent) return;
  const ev = currentEvent;
  const saved = ev.completion_photos || [];
  const startIndex = replace ? 0 : saved.length;
  const blobs = await pickPhotoBlobs(MAX_DONE_PHOTOS - startIndex);
  if (blobs.length === 0) return;

  setDonePhotoMsg("업로드 중...", false);
  let result;
  try {
    const urls = await uploadDonePhotos(ev, blobs, startIndex);
    await saveDonePhotoUrls(ev, urls, startIndex);
    result = { text: `${urls.length}장 저장했습니다. 다음 보고서부터 반영됩니다.`, error: false };
  } catch (e) {
    console.error("완료사진 업로드 오류:", e);
    result = {
      text: e.code === "storage/unauthorized"
        ? "업로드 권한이 없습니다. 관리자 계정인지 확인해주세요."
        : "업로드에 실패했습니다. 잠시 후 다시 시도해주세요.",
      error: true,
    };
  }
  // 결과 메시지는 재렌더 **뒤에** 넣는다 — renderDonePhotos가 actions를 다시 그리면서
  // 메시지 요소를 새로 만들기 때문에, 순서가 반대면 방금 띄운 메시지가 지워진다.
  renderDonePhotos(ev);
  setDonePhotoMsg(result.text, result.error);
}

// 아직 완료되지 않은 이벤트 팝업에서: 대기 목록에만 넣고, [완료 처리] 때 함께 올린다
async function pickPendingDonePhotos() {
  if (!currentEvent) return;
  const room = MAX_DONE_PHOTOS - (currentEvent.completion_photos || []).length - pendingDonePhotos.length;
  if (room <= 0) { alert(`완료 사진은 최대 ${MAX_DONE_PHOTOS}장입니다.`); return; }
  const blobs = await pickPhotoBlobs(room);
  blobs.forEach(blob => pendingDonePhotos.push({ blob, previewUrl: URL.createObjectURL(blob) }));
  renderDonePhotos(currentEvent);
}

function clearPendingDonePhotos() {
  pendingDonePhotos.forEach(p => URL.revokeObjectURL(p.previewUrl));
  pendingDonePhotos = [];
}

function renderDonePhotos(ev) {
  const sec     = document.getElementById("done-photo-section");
  const grid    = document.getElementById("done-photo-grid");
  const actions = document.getElementById("done-photo-actions");
  const saved   = ev.completion_photos || [];
  const isAdmin = userIsAdmin(currentUser);

  // 관리자가 아니고 사진도 없으면 섹션을 통째로 감춘다 (빈 칸만 남는 걸 피함)
  if (!isAdmin && saved.length === 0) { sec.style.display = "none"; return; }
  sec.style.display = "block";

  const cards = [
    ...saved.map((url, i) => ({ url, label: `완료사진${i + 1}`, pending: false })),
    ...pendingDonePhotos.map((p, i) => ({ url: p.previewUrl, label: `첨부 대기 ${i + 1}`, pending: true })),
  ];
  grid.innerHTML = cards.length === 0
    ? `<div class="no-photo">아직 완료 사진이 없습니다.</div>`
    : cards.map((c, idx) => `
      <div>
        <img class="photo-thumb${c.pending ? " pending" : ""}" data-idx="${idx}"
             src="${esc(c.url)}" alt="${esc(c.label)}">
        <div style="font-size:11px;color:var(--gray4);text-align:center;margin-top:4px">${esc(c.label)}</div>
      </div>`).join("");
  grid.querySelectorAll(".photo-thumb").forEach(img => {
    img.addEventListener("click", () => openEventViewer(cards[Number(img.dataset.idx)].url));
  });

  actions.innerHTML = "";
  if (!isAdmin) return;

  // 완료된 건이면 이 자리에서 바로 업로드, 아직 진행 중이면 [완료 처리] 때 함께 올린다
  const isDone = ev.status === "완료";
  const full   = saved.length + pendingDonePhotos.length >= MAX_DONE_PHOTOS;
  const btn = document.createElement("button");
  btn.className = "btn btn-photo";
  // 교체(덮어쓰기)는 이미 올라간 사진이 있는 완료 건에서만 의미가 있다.
  // 아직 완료 전이라 대기 중인 사진은 업로드된 게 아니라서 교체할 대상이 없다 —
  // 이 경우는 버튼을 잠그고, 다시 고르려면 팝업을 닫았다 열면 된다.
  btn.textContent = !full ? "📎 완료 사진 첨부"
    : isDone ? "🔄 완료 사진 교체"
    : `📎 ${MAX_DONE_PHOTOS}장 첨부됨`;
  btn.disabled = full && !isDone;
  btn.onclick = () => isDone ? attachDonePhotos(full) : pickPendingDonePhotos();
  actions.appendChild(btn);

  const msg = document.createElement("div");
  msg.id = "done-photo-msg";
  msg.className = "done-photo-msg";
  if (!isDone && pendingDonePhotos.length > 0) {
    msg.textContent = `${pendingDonePhotos.length}장 첨부 대기 중 — [완료 처리]를 눌러야 저장됩니다.`;
  } else if (full && isDone) {
    msg.textContent = "다시 올리면 기존 사진을 덮어씁니다.";
  }
  actions.appendChild(msg);
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


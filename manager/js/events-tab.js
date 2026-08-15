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
  resetDoneDraft(currentEvent); // 이전 팝업에서 고르고 안 올린 사진이 넘어오지 않게
  const isDone = currentEvent.status === "완료";
  document.getElementById("modal-dot").className        = `status-dot ${currentEvent.status}`;
  document.getElementById("modal-title-text").textContent = currentEvent.memo || "";
  document.getElementById("m-center").textContent       = currentEvent.center_name  || "";
  document.getElementById("m-facility").textContent     = currentEvent.fid_name || currentEvent.facility_id  || "";
  document.getElementById("m-worker").textContent       = currentEvent.worker        || "";
  document.getElementById("m-datetime").textContent     = currentEvent.datetime      || "";
  loadEventPhotos(currentEvent); // 완료 사진까지 같은 그리드에 그린다(renderModalPhotos)
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
         <button class="btn btn-action" onclick="submitAction('진행중', this)">🟡 조치 진행</button>
         <button class="btn btn-done"   onclick="submitAction('완료', this)">🟢 완료 처리</button>
       </div>`;
  // 완료 사진 첨부 버튼은 renderModalPhotos가 사진 그리드 밑에 그린다 — 완료 전에는
  // 초안에만 담고 [완료 처리]를 누를 때 함께 올라간다.
  document.getElementById("modal-overlay").classList.add("open");
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById("modal-overlay")) closeModal();
}
function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  resetDoneDraft(null);
  currentEvent = null;
}

async function submitAction(type, btn) {
  const content = (document.getElementById("action-text")?.value||"").trim();
  if (!content) { alert("내용을 입력하세요."); return; }
  if (!currentEvent) return;

  // 완료 사진은 완료 처리에만 붙는다. 첨부해 놓고 [조치 진행]을 누르면 그대로 사라지므로
  // 조용히 버리지 않고 한 번 물어본다.
  if (type !== "완료" && doneDraft.some(d => d.kind === "new") &&
      !confirm("첨부한 완료 사진은 [완료 처리]할 때만 저장됩니다. 사진 없이 진행할까요?")) return;

  const ev = currentEvent;
  let photoFailed = false;

  try {
    await withSpinner(btn, type === "완료" ? "완료 처리 중..." : "저장 중...", async () => {
      // [2026-08-15] 사진을 **먼저** 올리고 문서는 **한 번만** 쓴다.
      // 예전엔 상태를 저장한 뒤 사진을 또 저장해서 서울(Firestore) 왕복이 두 번 났다.
      // ⚠️ 사진이 실패해도 완료 처리는 그대로 진행한다 — 사진 때문에 업무 흐름이 막히는
      //   쪽이 더 나쁘다. 그래서 아래에서 completion_photos 필드만 빼고 저장한다.
      //   못 올린 건 완료 탭에서 [완료 사진 첨부]로 다시 올리면 된다.
      let photoUrls = null;
      if (type === "완료" && isDoneDraftDirty(ev)) {
        try { photoUrls = await resolveDraftUrls(ev); }
        catch (e) { console.error("완료사진 업로드 오류:", e); photoFailed = true; }
      }

      await db.collection("events").doc(ev.id).update({
        status:           type,
        history:          firebase.firestore.FieldValue.arrayUnion({
          type, content, by: currentUser.name||"", at: firebase.firestore.Timestamp.now(),
        }),
        last_notified_at: firebase.firestore.Timestamp.now(),
        updated_at:       firebase.firestore.FieldValue.serverTimestamp(),
        ...(type==="완료" ? { completed_at: firebase.firestore.FieldValue.serverTimestamp() } : {}),
        ...(photoUrls ? { completion_photos: photoUrls } : {}),
      });
      if (photoUrls) applyDoneUrls(ev, photoUrls);
    });
    closeModal();
    if (photoFailed) {
      showToast("완료 처리는 됐지만 사진 저장에 실패했습니다. 완료 탭에서 다시 첨부해주세요.", true);
    } else {
      showToast(type === "완료" ? "완료 처리되었습니다." : "조치 내용을 저장했습니다.");
    }
  } catch(e) {
    console.error("조치 처리 오류:", e);
    showToast("처리 중 오류가 발생했습니다.", true);
  }
}

// 점검 사진 카드 (loadEventPhotos가 채우고, renderModalPhotos가 완료 사진과 같이 그린다)
let modalPhotoCards   = [];
let modalPhotoLoading = false;

async function loadEventPhotos(ev) {
  modalPhotoCards = [];
  modalPhotoLoading = false;

  // ① events에 photos URL이 있으면 바로 사용
  const photoUrls = (ev.photos || "").split(",").map(s => s.trim()).filter(Boolean);
  if (photoUrls.length > 0) {
    modalPhotoCards = photoUrls.map(url => ({ url }));
    renderModalPhotos();
    return;
  }

  // ② photos URL 없으면 파일명 패턴으로 Storage에서 조회 (병렬 처리)
  const count = toCount(ev.photo_count);
  if (count === 0) { renderModalPhotos(); return; }
  modalPhotoLoading = true;
  renderModalPhotos();
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
  results.filter(r => r.status === "rejected").forEach(r => console.warn("사진 로드 실패:", r.reason?.code || r.reason));

  modalPhotoCards = results.filter(r => r.status === "fulfilled").map(r => r.value);
  modalPhotoLoading = false;
  renderModalPhotos();
}

// ──────────────────────────────────────────────
// 완료 사진 — 관리자가 올리는 완료 증빙. 이벤트 보고서의 완료사진1·2(J·K열)로 나간다.
// [2026-08-14 신규 / 2026-08-15 개편]
//
// 파일명을 나중에 추정하지 않는다: 업로드 직후 받은 다운로드 URL을 events 문서의
// completion_photos에 저장하고, 화면도 보고서도 그 URL만 쓴다. 점검 사진은 파일명 규칙을
// 다섯 곳에서 각자 추정하다 서로 어긋난 이력이 있어서(system_map.md 4번), 새로 만드는
// 경로에서는 추정 자체를 없앴다.
//
// [초안(draft) 모델 — 2026-08-15]
// 고른 사진과 X로 뺀 결과를 doneDraft에 모아뒀다가 **저장 시점에 한 번에** 반영한다.
//   · 아직 완료 전  : [완료 처리]를 누를 때 같이 저장
//   · 이미 완료된 건: [첨부 완료]를 누를 때 저장
// 처음엔 고르는 즉시 업로드했는데, 그러면 잘못 고른 사진을 되돌릴 방법이 없었다.
// ──────────────────────────────────────────────
const MAX_DONE_PHOTOS      = 2;    // 보고서 완료사진 열이 2개다
const DONE_PHOTO_MAX_WIDTH = 1600; // 아래 압축 규칙은 M-SMART public/js/photo.js와 같은 값
const DONE_PHOTO_QUALITY   = 0.85;

// 완료 사진 초안: { kind:"saved", url } | { kind:"new", blob, previewUrl }
let doneDraft = [];
// 압축이 끝나기 전까지 그리드에 띄워둘 "처리 중" 카드 수
let donePlaceholders = 0;

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
//
// onFilesChosen: 파일을 고른 직후(압축 시작 전) 장수를 알려준다. 압축이 메인 스레드를
//   잡기 때문에, 호출부가 이 시점에 "처리 중" 표시를 그려두지 않으면 사용자에겐 아무
//   반응 없는 정지 구간으로 보인다.
function pickPhotoBlobs(limit, onFilesChosen) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = limit > 1;
    input.onchange = async e => {
      const files = Array.from(e.target.files || []).slice(0, limit);
      if (files.length > 0 && onFilesChosen) await onFilesChosen(files.length);
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
//   덮어쓰기가 일어나면 GCS가 객체 메타데이터를 **병합이 아니라 교체**해서 Firebase
//   다운로드 토큰(URL 끝의 ?token=...)이 새로 발급된다. 즉 **이전 URL은 그 순간 죽는다.**
//   put() → getDownloadURL() → 문서 갱신을 한 묶음으로 유지할 것.
//
// 📌 [2026-08-15] 파일명에 타임스탬프를 넣어 **매번 새 파일로** 올린다. 예전엔 자리 번호
//   (_1/_2)로 덮어썼는데, X로 사진을 빼면 자리가 밀려서 **남아 있는 사진의 파일을 덮어써**
//   그 사진의 URL까지 죽는다(토큰이 바뀌므로). 순서는 문서의 배열이 정하니 파일명이
//   자리를 뜻할 필요가 없다.
//
// ⚡ [2026-08-15] 순차 → 병렬. M-SMART submit.js가 2026-08-01에 같은 전환을 하면서 남긴
//   실측이 근거다: **장당 4~5초, 파일이 134~455KB로 작은데도** 그랬다. 즉 전송량보다
//   요청 왕복 비용이 지배적이라 겹쳐 보내면 장수가 늘어도 총 시간이 거의 안 는다.
//   이 프로젝트의 Storage 버킷은 US-CENTRAL1(서울이 아님)이라 왕복 비용이 특히 크다.
//   Promise.all은 입력 순서를 보존하므로 보고서 J·K 순서도 안 뒤바뀐다.
async function uploadDonePhotos(ev, blobs) {
  // 시각 + 난수 4자리. 시각만 쓰면 같은 밀리초에 두 번 저장할 때 겹칠 수 있고,
  // 겹치는 순간 덮어쓰기가 되어 위에 적은 토큰 무효화 문제가 그대로 재현된다.
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return Promise.all(blobs.map(async (blob, i) => {
    const ref  = storage.ref(`completion_photos/${ev.center_name}/${ev.id}_${stamp}_${i + 1}.jpg`);
    const snap = await ref.put(blob, { contentType: "image/jpeg" });
    return snap.ref.getDownloadURL();
  }));
}

// 초안을 스토리지·문서에 반영한다. 새로 고른 것만 올리고, 최종 순서는 초안 순서 그대로다.
// X로 뺀 사진의 Storage 파일은 남는다 — 규칙에서 delete를 안 열었기 때문이고, 문서에서
// 빠지면 화면·보고서 어디에도 안 나오므로 사용자 눈에는 취소된 것과 같다.
// 새로 고른 것만 올려서 최종 URL 배열을 만든다. **문서는 쓰지 않는다** —
// 완료 처리 흐름이 상태 변경과 사진을 문서 쓰기 한 번으로 합칠 수 있게 분리해 뒀다.
async function resolveDraftUrls(ev) {
  const newItems = doneDraft.filter(d => d.kind === "new");
  const uploaded = newItems.length > 0 ? await uploadDonePhotos(ev, newItems.map(d => d.blob)) : [];
  let n = 0;
  return doneDraft
    .map(d => d.kind === "saved" ? d.url : uploaded[n++])
    .filter(Boolean)
    .slice(0, MAX_DONE_PHOTOS);
}

// 저장된 결과를 화면 상태에 반영 (문서 쓰기는 호출부가 이미 했다는 전제)
function applyDoneUrls(ev, urls) {
  ev.completion_photos = urls;              // 화면 즉시 반영 (onSnapshot이 뒤이어 갱신한다)
  doneDraft.forEach(d => { if (d.kind === "new") URL.revokeObjectURL(d.previewUrl); });
  doneDraft = urls.map(url => ({ kind: "saved", url }));
}

// [첨부 완료] 전용 — 사진만 저장한다(상태 변경 없음)
async function commitDoneDraft(ev) {
  const urls = await resolveDraftUrls(ev);
  await db.collection("events").doc(ev.id).update({
    completion_photos: urls,
    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
  });
  applyDoneUrls(ev, urls);
  return { total: urls.length };
}

// 초안이 저장된 상태와 다른가 (= 저장 버튼을 켤지 판단)
function isDoneDraftDirty(ev) {
  const saved = (ev && ev.completion_photos) || [];
  if (doneDraft.length !== saved.length) return true;
  return doneDraft.some((d, i) => d.kind !== "saved" || d.url !== saved[i]);
}

// 팝업을 열고 닫을 때 초안을 문서 상태로 되돌린다(ev가 없으면 비운다)
function resetDoneDraft(ev) {
  doneDraft.forEach(d => { if (d.kind === "new") URL.revokeObjectURL(d.previewUrl); });
  doneDraft = ((ev && ev.completion_photos) || []).map(url => ({ kind: "saved", url }));
}

function removeDonePhoto(idx) {
  const [removed] = doneDraft.splice(idx, 1);
  if (removed && removed.kind === "new") URL.revokeObjectURL(removed.previewUrl);
  renderModalPhotos();
}

async function pickDonePhotos() {
  const room = MAX_DONE_PHOTOS - doneDraft.length;
  if (room <= 0) { showToast(`완료 사진은 최대 ${MAX_DONE_PHOTOS}장입니다.`, true); return; }
  try {
    // 고른 직후 자리표시를 먼저 그리고 한 프레임 양보한 뒤에 압축이 시작된다
    // (양보가 없으면 표시가 화면에 나오기 전에 메인 스레드가 막혀 아무것도 안 보인다)
    const blobs = await pickPhotoBlobs(room, async count => {
      donePlaceholders = count;
      renderModalPhotos();
      await nextPaint();
    });
    blobs.forEach(blob => doneDraft.push({ kind: "new", blob, previewUrl: URL.createObjectURL(blob) }));
  } finally {
    donePlaceholders = 0;
    renderModalPhotos();
  }
}

// 완료된 건의 [첨부 완료] — 여기서 스토리지에 저장한다
async function saveDonePhotos(btn) {
  if (!currentEvent) return;
  const ev = currentEvent;
  try {
    const { total } = await withSpinner(btn, "저장 중...", () => commitDoneDraft(ev));
    renderModalPhotos();
    showToast(total > 0 ? `완료 사진 ${total}장을 저장했습니다.` : "완료 사진을 모두 지웠습니다.");
  } catch (e) {
    console.error("완료사진 저장 오류:", e);
    renderModalPhotos();
    showToast(e.code === "storage/unauthorized"
      ? "업로드 권한이 없습니다. 관리자 계정인지 확인해주세요."
      : "저장에 실패했습니다. 잠시 후 다시 시도해주세요.", true);
  }
}

// 점검 사진과 완료 사진을 **한 그리드에** 그린다.
// [2026-08-15] 섹션을 둘로 나눴더니 팝업이 길어져서 완료 처리 버튼까지 스크롤해야 했다.
// 점검 3장 + 완료 2장 = 최대 5장이라 한 줄에 들어간다.
function renderModalPhotos() {
  const sec     = document.getElementById("photo-section");
  const grid    = document.getElementById("photo-grid");
  const actions = document.getElementById("photo-actions");
  if (!sec || !currentEvent) return;
  const ev      = currentEvent;
  const isAdmin = userIsAdmin(currentUser);
  const isDone  = ev.status === "완료";

  const cards = [
    ...modalPhotoCards.map(c => ({ ...c, kind: "insp" })),
    ...doneDraft.map((d, i) => ({
      url:     d.kind === "saved" ? d.url : d.previewUrl,
      label:   `✅ 완료사진${i + 1}${d.kind === "new" ? " (대기)" : ""}`,
      kind:    "done",
      pending: d.kind === "new",
      doneIdx: i,
    })),
    // 압축이 끝나기 전 자리표시 (썸네일이 뜰 자리에 미리 칸을 잡아둔다)
    ...Array.from({ length: donePlaceholders }, () => ({ kind: "placeholder" })),
  ];

  // 볼 사진도 없고 올릴 권한도 없으면 섹션을 통째로 감춘다
  if (cards.length === 0 && !modalPhotoLoading && !isAdmin) { sec.style.display = "none"; return; }
  sec.style.display = "block";

  grid.innerHTML =
    (modalPhotoLoading && cards.length === 0)
      ? `<div class="photo-loading"><span class="btn-spinner"></span>사진 불러오는 중...</div>`
      : cards.length === 0
        ? `<div class="no-photo">사진이 없습니다.</div>`
        : cards.map((c, idx) => c.kind === "placeholder" ? `
          <div class="photo-card-wrap">
            <div class="photo-thumb photo-thumb-loading"><span class="btn-spinner"></span></div>
            <div style="font-size:11px;color:var(--gray4);text-align:center;margin-top:4px">사진 처리 중</div>
          </div>` : `
          <div class="photo-card-wrap">
            <img class="photo-thumb${c.kind === "done" ? " done" : ""}${c.pending ? " pending" : ""}"
                 data-idx="${idx}" src="${esc(c.url)}" alt="${esc(c.label || "사진")}"
                 ${c.fileName ? `title="${esc(c.fileName)}"` : ""}>
            ${c.kind === "done" && isAdmin
              ? `<button class="photo-x" data-done-idx="${c.doneIdx}" title="첨부 취소">✕</button>` : ""}
            ${c.label ? `<div style="font-size:11px;color:var(--gray4);text-align:center;margin-top:4px">${esc(c.label)}</div>` : ""}
          </div>`).join("");

  grid.querySelectorAll(".photo-thumb").forEach(img => {
    img.addEventListener("click", () => openEventViewer(cards[Number(img.dataset.idx)].url));
  });
  grid.querySelectorAll(".photo-x").forEach(x => {
    x.addEventListener("click", e => { e.stopPropagation(); removeDonePhoto(Number(x.dataset.doneIdx)); });
  });

  actions.innerHTML = "";
  if (!isAdmin) return;

  if (doneDraft.length < MAX_DONE_PHOTOS) {
    const add = document.createElement("button");
    add.className = "btn btn-photo";
    add.textContent = "📎 완료 사진 첨부";
    add.onclick = () => pickDonePhotos();
    actions.appendChild(add);
  }

  // 이미 완료된 건은 여기서 저장한다. 완료 전이면 [완료 처리]가 저장 시점이라 버튼을 따로
  // 두지 않는다 — 같은 일을 하는 버튼이 둘로 보이는 걸 피한다.
  const dirty = isDoneDraftDirty(ev);
  if (isDone) {
    const save = document.createElement("button");
    save.className = "btn btn-save";
    save.textContent = "💾 첨부 완료";
    save.disabled = !dirty;
    save.onclick = () => saveDonePhotos(save);
    actions.appendChild(save);
  }

  const msg = document.createElement("div");
  msg.className = "done-photo-msg";
  if (dirty) {
    msg.textContent = isDone
      ? "변경사항이 있습니다 — [첨부 완료]를 눌러야 저장됩니다."
      : "[완료 처리]를 누르면 사진도 같이 저장됩니다.";
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


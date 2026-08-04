// ──────────────────────────────────────────────
// 로그인 — 서버(Cloud Function: loginWithCredentials)에서 판정 + Custom Token 발급
// 화면상 UX(이름+전화번호 입력)는 기존과 동일. 뒤에서만 진짜 Firebase Auth로 바뀜.
// ──────────────────────────────────────────────
async function login() {
  const name  = document.getElementById("login-name").value.trim();
  const phone = document.getElementById("login-phone").value.replace(/[^0-9]/g, "");
  const errEl = document.getElementById("login-error");
  const btnEl = document.querySelector(".login-btn");
  errEl.textContent = "";
  if (!name || !phone) { errEl.textContent = "이름과 전화번호를 입력하세요."; return; }

  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 로그인 중...`; }
  try {
    const callLogin = functions.httpsCallable("loginWithCredentials");
    const res = await callLogin({ name, phone, app: "m-event" }); // password는 향후 도입 시 여기에 추가
    const { token, user } = res.data;

    await auth.signInWithCustomToken(token); // 성공하면 onAuthStateChanged가 이어서 처리
    currentUser = user;
    showApp();
  } catch (e) {
    console.error("로그인 오류:", e);
    // HttpsError의 message는 "resource-exhausted: 로그인 시도가..." 형태로 오므로 콜론 앞부분 제거
    errEl.textContent = (e.message || "").replace(/^[a-z-]+:\s*/i, "") || "로그인 중 오류가 발생했습니다.";
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = "로그인"; }
  }
}

function logout() {
  if (unsubscribe) unsubscribe();
  currentUser = null; allEvents = [];
  auth.signOut(); // onAuthStateChanged(null)이 이어서 로그인 화면 전환 처리
}

// ==============================================================================
// [권한 판정] functions/lib/permissions.js 의 규칙을 브라우저에서 그대로 쓴 것.
//
// ⚠️ 프런트엔드는 script 태그로 로드되어 require가 없어서 서버 모듈을 못 가져온다.
//   규칙을 바꾸면 functions/lib/permissions.js(그리고 Dashboard·M-Engine의 사본)도
//   같이 고칠 것. 참고로 **여기서 막는 건 화면 표시일 뿐**이고 실제 권한은 서버
//   (Callable Function)와 storage.rules가 검사한다 — 이 함수를 우회해도 데이터는 못 얻는다.
//
// [전환기 폴백] role이 없으면 예전 의미(active === true)로 판정한다. 커스텀 클레임은
//   **토큰을 새로 받기 전까지 갱신되지 않아서**, 이미 로그인해 있는 사람은 재로그인
//   전까지 role 없는 옛 토큰을 들고 다닌다. 폴백이 없으면 그 사람들의 보고서 탭이
//   재로그인할 때까지 사라진다. 백필 완료 후 폴백만 지우면 된다.
// ==============================================================================
// [2026-08-04] 전환기 폴백(role이 없으면 active로 판정) 제거 — 이제 role만 본다.
// 이 값은 토큰 클레임에서 복원한 currentUser라, role이 없는 옛 세션은 관리자 UI가
// 보이지 않는다. 폴백 제거 전에 기존 관리자 토큰을 폐기해 재로그인시켰다.
function userIsAdmin(u) {
  return !!u && u.role === "admin";
}

// 새로고침/재방문 시 Firebase Auth가 세션을 자체 관리 (sessionStorage 더 이상 불필요).
// 커스텀 클레임(name/center_name/role/active)에서 currentUser를 복원함.
auth.onAuthStateChanged(async (fbUser) => {
  if (fbUser) {
    if (!currentUser) {
      try {
        const idTokenResult = await fbUser.getIdTokenResult();
        currentUser = {
          name: idTokenResult.claims.name || "",
          center_name: idTokenResult.claims.center_name || "",
          role: idTokenResult.claims.role || null,   // 없으면 아래 폴백이 active를 본다
          active: idTokenResult.claims.active === true,
        };
        showApp();
      } catch (e) {
        console.error("세션 복원 실패:", e);
        auth.signOut();
      }
    }
  } else {
    currentUser = null;
    document.getElementById("app").style.display          = "none";
    document.getElementById("login-screen").style.display = "flex";
  }
});

window.onload = () => {
  const today    = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  ["excel","photo","report"].forEach(k => {
    document.getElementById(`filter-start-${k}`).value = fmt(firstDay);
    document.getElementById(`filter-end-${k}`).value   = fmt(today);
  });
};
document.addEventListener("keydown", e => {
  if (e.key==="Enter" && document.getElementById("login-screen").style.display!=="none") login();
});

// ──────────────────────────────────────────────
// 앱 초기화
// ──────────────────────────────────────────────
// [2026-07-11 변경] Dashboard의 /api/fidlocations를 빌려쓰던 것을,
// firestore.rules가 이미 center_configs/{center}/** 를 로그인 사용자
// 본인 센터(또는 Master)에 한해 직접 읽도록 허용하고 있어서 Firestore를
// 여기서 직접 읽는 방식으로 전환. Dashboard가 죽어있어도 m-event가
// 더 이상 영향받지 않음(system_map.md의 "m-event → facility-dashboard"
// 의존 항목 해소).
async function loadFidLocations(centerOverride) {
  try {
    const center = centerOverride || (currentUser.center_name === "Master" ? "" : currentUser.center_name);
    if (!center) return;

    const [facilitiesSnap, inspectionsSnap] = await Promise.all([
      db.collection("center_configs").doc(center).collection("facilities").get(),
      db.collection("center_configs").doc(center).collection("inspections").get(),
    ]);

    const locations = {};
    facilitiesSnap.forEach(doc => {
      locations[doc.id] = doc.data().fid_name || doc.id;
    });

    const labels = {};
    inspectionsSnap.forEach(doc => {
      const data = doc.data();
      const label = data.sheet_label || doc.id;
      const fids = Array.isArray(data.fids) ? data.fids : [];
      fids.forEach(fid => { labels[String(fid).trim()] = label; });
    });

    fidLocations = locations;
    sheetLabels = labels;
  } catch(e) { console.warn("fidLocations 로드 실패:", e); }
}

async function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display          = "flex";
  updateHeaderUser();

  // 보고서 탭·출근부 업로드는 관리자만 표시.
  // ⚠️ [2026-08-01] 예전엔 `active === true || center_name === "Master"`였다. Master를 OR로
  //   묶지 않는 이유는 서버(functions/lib/report-export.js)의 같은 자리 주석 참고 —
  //   서버가 role만 보고 거절하므로, 여기서 Master에게 탭을 보여주면 눌렀을 때
  //   "권한이 없습니다"가 뜨는 화면/서버 불일치가 생긴다. 판정을 서버와 일치시킨다.
  const isAdmin = userIsAdmin(currentUser);
  document.getElementById("tab-report").style.display = isAdmin ? "flex" : "none";
  document.getElementById("wl-attendance-pick-btn").style.display = isAdmin ? "inline-block" : "none";
  document.getElementById("wl-attendance-hint").style.display = isAdmin ? "flex" : "none";

  await buildCenterFilters();
  loadFidLocations();
  subscribeEvents();
}

// 헤더의 "이름 · 소속" 표시.
// [2026-08-05] 예전엔 Master를 "마스터 (전체)"로 적었는데, 전 센터 조회를 없앤 지금은
// 사실과 다르다. 센터를 고르기 전엔 "마스터", 고른 뒤엔 그 센터를 같이 보여준다.
function updateHeaderUser() {
  const el = document.getElementById("header-user");
  if (!el || !currentUser) return;
  let label;
  if (currentUser.center_name !== "Master") {
    label = currentUser.center_name;
  } else {
    const picked = currentCenter();
    label = picked ? `마스터 · ${picked}` : "마스터";
  }
  el.textContent = `${currentUser.name} · ${label}`;
}

async function buildCenterFilters() {
  const isMaster = currentUser.center_name === "Master";

  // 센터 목록 조회 — Master만 필요하다.
  // [2026-08-01] 예전엔 소속과 무관하게 항상 조회했는데, 아래를 보면 centers는
  // isMaster일 때만 쓰인다(일반 사용자는 자기 센터 하나로 고정). 쓰지도 않는 값을
  // 받으려고 전 센터 목록을 읽던 셈이라, firestore.rules에서 이 문서를 Master로
  // 좁히면서 클라이언트도 같이 정리했다.
  let centers = [];
  if (isMaster) {
    try {
      const doc = await db.collection("settings").doc("all_centers").get();
      if (doc.exists) centers = (doc.data().centers || []).sort();
    } catch(e) { console.warn("센터 목록 조회 실패:", e); }
  }

  // 센터 드롭다운 6개(이벤트/엑셀/사진/보고서/점검표/근무일지)를 같은 규칙으로 채운다.
  //
  // ⚠️ [2026-08-05] Master의 첫 항목이 "전체"였는데 없앴다. "전체"는 각 쿼리에서
  //   center_name 필터를 빼는 뜻이라 **전 센터 조회**가 되고, 센터가 늘수록 그 경로만
  //   무거워진다(facility-dashboard도 같은 이유로 같은 날 전 센터 합산 조회를 제거했다).
  //   이제 고르기 전까지는 각 탭이 조회를 시작하지 않고 안내만 보여준다.
  const optionsHtml = isMaster
    ? `<option value="">센터를 선택하세요</option>` +
      centers.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")
    : `<option value="${esc(currentUser.center_name)}">${esc(currentUser.center_name)}</option>`;

  for (const id of CENTER_SELECT_IDS) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    sel.innerHTML = optionsHtml;
    sel.disabled = !isMaster;   // 비-Master는 자기 센터 고정

    // 📌 조작 가능한 드롭다운은 **이벤트 탭 것 하나뿐**이다. 나머지 탭의 select는
    //   화면에서 감추고 값만 동기화한다 — 각 탭 코드가 예전처럼 자기 select를 읽어도
    //   그대로 동작하게 하기 위해 DOM에는 남겨둔다. 앞에 붙은 "센터" 라벨도 같이 숨긴다.
    if (id !== "filter-center-event") {
      sel.style.display = "none";
      const prev = sel.previousElementSibling;
      if (prev && prev.tagName === "LABEL") prev.style.display = "none";
    }
  }

  // 이벤트 탭 드롭다운은 로그인 전까지 숨겨져 있다.
  const eventSel = document.getElementById("filter-center-event");
  if (eventSel) eventSel.style.display = "block";

  lockTabsUntilCenter();

  // 보고서 탭 서브탭 앞 센터 라벨 (근무일지 탭의 wl-center-label과 동일한 패턴)
  const reportLabelEl = document.getElementById("report-center-label");
  if (reportLabelEl) reportLabelEl.textContent = isMaster ? "📊 전체 센터" : `📊 ${currentUser.center_name}`;
}

// ──────────────────────────────────────────────
// 페이지 전환 (이벤트 / 엑셀 / 사진)
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// 센터 미선택 잠금 (2026-08-05 신설)
//
// 센터를 고르는 곳은 이벤트 탭 드롭다운 하나뿐이라, 고르기 전에는 나머지 탭에 들어가도
// 볼 게 없다(조회 자체를 안 한다). 빈 화면을 보여주느니 탭을 잠가서 "여기서 먼저 고르라"는
// 걸 분명히 한다. 비-Master는 센터가 항상 정해져 있으므로 잠기지 않는다.
// ──────────────────────────────────────────────
const LOCKABLE_PAGES = ["excel", "photo", "worklog", "report"];

function lockTabsUntilCenter() {
  const locked = !currentCenter();
  LOCKABLE_PAGES.forEach(page => {
    const tab = document.querySelector(`.main-tab[data-page="${page}"]`);
    if (!tab) return;
    tab.classList.toggle("tab-locked", locked);
    tab.title = locked ? "먼저 이벤트 탭에서 센터를 선택하세요" : "";
  });
  // 잠긴 탭을 보고 있는 상태에서 센터가 미선택으로 바뀌면 이벤트 탭으로 되돌린다.
  if (locked && LOCKABLE_PAGES.includes(currentPage)) switchPage("event");
}

function switchPage(page) {
  // 잠긴 탭은 무시하고 안내만 — 센터를 고르기 전에는 어차피 조회가 안 된다.
  if (LOCKABLE_PAGES.includes(page) && !currentCenter()) {
    const sel = document.getElementById("filter-center-event");
    if (sel) { sel.focus(); }
    return;
  }
  currentPage = page;
  document.querySelectorAll(".main-tab").forEach(el =>
    el.classList.toggle("active", el.dataset.page === page));
  document.querySelectorAll(".page").forEach(el =>
    el.classList.toggle("active", el.id === `page-${page}`));
  if (page === "worklog" && !wlCenter) wlInit();
  // 센터 미선택 상태로 다른 탭에 들어오면 그 탭에도 안내가 떠야 한다
  // (탭마다 목록 영역이 달라서 진입 시점에 한 번 그려준다).
  if (!currentCenter()) showCenterPromptForPage(page);
}

// ──────────────────────────────────────────────
// 센터 선택 변경 (2026-08-05 신설)
//
// 드롭다운이 탭마다 있어서, 어느 것을 고르든 나머지를 같은 값으로 맞춘다.
// 탭마다 따로 고르게 하면 Master가 화면을 옮길 때마다 다시 골라야 해서 더 번거롭다.
// ──────────────────────────────────────────────
function onCenterChange(value) {
  syncCenterSelects(value);
  updateHeaderUser();
  lockTabsUntilCenter();
  wlCenter = null;              // 근무일지는 센터가 바뀌면 처음부터 다시 초기화된다
  eventPage = 1;

  if (!value) {
    // 미선택으로 되돌린 경우 — 모든 탭을 안내 상태로 되돌리고 구독도 끊는다.
    if (typeof unsubscribe === "function") { unsubscribe(); unsubscribe = null; }
    allEvents = [];
    updateBadge();
    ["event", "excel", "photo", "report", "worklog"].forEach(showCenterPromptForPage);
    return;
  }

  // 현재 보고 있는 탭만 즉시 새로 불러온다. 나머지 탭은 이전 센터 결과가 남아 있으면
  // 오해를 부르므로 비우고, 그 탭에 들어가서 조회를 누르면 새 센터로 조회된다.
  if (currentPage === "event")        subscribeEvents();
  else if (currentPage === "worklog") wlInit();
  else if (currentPage === "excel")   loadExcel();
  else if (currentPage === "photo")   loadDashPhotos();

  ["event", "excel", "photo", "report", "worklog"]
    .filter(p => p !== currentPage)
    .forEach(clearPageResults);
}

/** 센터 미선택 안내를 탭별 목록 영역에 그린다. */
function showCenterPromptForPage(page) {
  if (page === "event")        renderCenterPrompt("event-list", "이벤트 목록");
  else if (page === "excel")   renderCenterPrompt("excel-list", "엑셀 파일 목록");
  else if (page === "photo")   renderCenterPrompt("photo-list", "점검 사진");
  else if (page === "report")  renderCenterPrompt("report-file-list", "보고서 목록");
  else if (page === "worklog") {
    const el = document.getElementById("wl-center-label");
    if (el) el.textContent = "📓 센터를 선택하세요";
    const titleEl = document.getElementById("wl-title-text");
    if (titleEl) titleEl.textContent = "센터를 선택하세요";
  }
}

/** 센터가 바뀌었을 때, 지금 안 보고 있는 탭의 이전 센터 결과를 비운다. */
function clearPageResults(page) {
  if (page === "excel")       renderCenterPrompt("excel-list", "엑셀 파일 목록");
  else if (page === "photo")  renderCenterPrompt("photo-list", "점검 사진");
  else if (page === "report") renderCenterPrompt("report-file-list", "보고서 목록");
}

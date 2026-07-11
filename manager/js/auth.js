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

  if (btnEl) { btnEl.disabled = true; btnEl.textContent = "로그인 중..."; }
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
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = "로그인"; }
  }
}

function logout() {
  if (unsubscribe) unsubscribe();
  currentUser = null; allEvents = [];
  auth.signOut(); // onAuthStateChanged(null)이 이어서 로그인 화면 전환 처리
}

// 새로고침/재방문 시 Firebase Auth가 세션을 자체 관리 (sessionStorage 더 이상 불필요).
// 커스텀 클레임(name/center_name/active)에서 currentUser를 복원함.
auth.onAuthStateChanged(async (fbUser) => {
  if (fbUser) {
    if (!currentUser) {
      try {
        const idTokenResult = await fbUser.getIdTokenResult();
        currentUser = {
          name: idTokenResult.claims.name || "",
          center_name: idTokenResult.claims.center_name || "",
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
  const centerLabel = currentUser.center_name === "Master" ? "마스터 (전체)" : currentUser.center_name;
  document.getElementById("header-user").textContent = `${currentUser.name} · ${centerLabel}`;

  // 보고서 탭 관리자/Master만 표시
  const isAdminOrMaster = currentUser.active === true || currentUser.center_name === "Master";
  document.getElementById("tab-report").style.display = isAdminOrMaster ? "flex" : "none";
  document.getElementById("wl-attendance-pick-btn").style.display = isAdminOrMaster ? "inline-flex" : "none";

  await buildCenterFilters();
  loadFidLocations();
  subscribeEvents();
}

async function buildCenterFilters() {
  const isMaster = currentUser.center_name === "Master";

  // 센터 목록 조회
  let centers = [];
  try {
    const doc = await db.collection("settings").doc("all_centers").get();
    if (doc.exists) centers = (doc.data().centers || []).sort();
  } catch(e) { console.warn("센터 목록 조회 실패:", e); }

  // 이벤트 탭 센터 드롭다운
  const eventSel = document.getElementById("filter-center-event");
  eventSel.style.display = "block";
  if (isMaster) {
    eventSel.disabled = false;
    eventSel.innerHTML = `<option value="">전체</option>` +
      centers.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  } else {
    eventSel.innerHTML = `<option value="${esc(currentUser.center_name)}">${esc(currentUser.center_name)}</option>`;
    eventSel.disabled = true;
  }

  for (const k of ["excel","photo","report"]) {
    const sel = document.getElementById(`filter-center-${k}`);
    if (!isMaster) {
      sel.innerHTML = `<option value="${esc(currentUser.center_name)}">${esc(currentUser.center_name)}</option>`;
      sel.disabled = true;
    } else {
      sel.disabled = false;
      sel.innerHTML = `<option value="">전체</option>` +
        centers.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    }
  }
}

// ──────────────────────────────────────────────
// 페이지 전환 (이벤트 / 엑셀 / 사진)
// ──────────────────────────────────────────────
function switchPage(page) {
  currentPage = page;
  document.querySelectorAll(".main-tab").forEach(el =>
    el.classList.toggle("active", el.dataset.page === page));
  document.querySelectorAll(".page").forEach(el =>
    el.classList.toggle("active", el.id === `page-${page}`));
  if (page === "worklog" && !wlCenter) wlInit();
}

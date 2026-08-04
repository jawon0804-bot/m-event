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
  const centerLabel = currentUser.center_name === "Master" ? "마스터 (전체)" : currentUser.center_name;
  document.getElementById("header-user").textContent = `${currentUser.name} · ${centerLabel}`;

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

  for (const k of ["excel","photo","report","report-insp"]) {
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

  // 보고서 탭 서브탭 앞 센터 라벨 (근무일지 탭의 wl-center-label과 동일한 패턴)
  const reportLabelEl = document.getElementById("report-center-label");
  if (reportLabelEl) reportLabelEl.textContent = isMaster ? "📊 전체 센터" : `📊 ${currentUser.center_name}`;
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

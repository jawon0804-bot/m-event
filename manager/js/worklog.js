// ──────────────────────────────────────────────
// 근무일지 (Firestore work_logs 실시간 연동)
// ──────────────────────────────────────────────
const WL_SECTIONS = {
  dayWork:   { sub: "dayWork",   fids: Array.from({length:10}, (_,i)=>`day_work_${i+1}`),   kind: "simple" },
  dayCheck:  { sub: "dayCheck",  fids: Array.from({length:10}, (_,i)=>`day_check_${i+1}`),  kind: "simple" },
  nightWork: { sub: "nightWork", fids: Array.from({length:10}, (_,i)=>`night_work_${i+1}`), kind: "simple" },
  nightNote: { sub: "nightNote", fids: Array.from({length:10}, (_,i)=>`night_note_${i+1}`), kind: "simple" },
  legal: {
    sub: "legal", kind: "multi",
    rows: Array.from({length:5}, (_,i) => ({
      sched: `legal_sched_${i+1}`, company: `legal_company_${i+1}`,
      contact: `legal_contact_${i+1}`, content: `legal_content_${i+1}`,
    })),
  },
  material: {
    sub: "material", kind: "multi",
    rows: Array.from({length:5}, (_,i) => ({
      workno: `mat_workno_${i+1}`, partno: `mat_partno_${i+1}`, qty: `mat_qty_${i+1}`,
      unit: `mat_unit_${i+1}`, usage: `mat_usage_${i+1}`, date: `mat_date_${i+1}`, stock: `mat_stock_${i+1}`,
    })),
  },
};

const WL_SINGLE_FIELDS = [
  "sig_staff","sig_manager","sig_teamlead","date_input","weather_input",
  "cnt_total","cnt_attend","cnt_day","cnt_night","cnt_off","cnt_rest","cnt_annual","cnt_compoff","cnt_edu","cnt_sick",
  "names_day","names_night","names_off",
  "util_water_name","util_water_prev","util_water_today","util_water_usage","util_water_cum","util_water_month",
  "util_kw_usage","util_kw_cum","util_kw_month",
];

const WL_TITLE_SUFFIX = "시설 업무일지"; // 필요 시 센터별로 다르게 하려면 여기를 조회 로직으로 교체

let wlCenter = null;
let wlWorkday = null;
let wlUnsubs = [];
let wlState = { dayWork: [], dayCheck: [], nightWork: [], nightNote: [], legal: [], material: [] };
let wlBaseDocRef = null;
let wlBaseSynced = {};       // 필드별 "마지막으로 Firestore와 동기화 확인된 값" — 변경분만 저장하기 위한 기준
let wlBaseFieldsBound = false; // 단일필드 blur 자동저장 리스너 중복 바인딩 방지

// 09:00 기준 근무일 계산 (백엔드 workLogDailyExport와 동일 로직 — 09:00 이전이면 전날로 취급)
// ※ 기존에는 toLocaleString() 문자열을 다시 Date로 파싱했는데, 이 포맷은 브라우저/OS 로캘에 따라
//   달라질 수 있어 컴퓨터마다 근무일 계산이 어긋날 위험이 있었음(서로 다른 문서를 보게 되는 원인).
//   Intl.DateTimeFormat.formatToParts로 KST 벽시계 값만 안전하게 추출하도록 수정.
function wlGetWorkday(d) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  let y   = parseInt(parts.year, 10);
  let m   = parseInt(parts.month, 10);
  let day = parseInt(parts.day, 10);
  const hour = parseInt(parts.hour, 10);

  if (hour < 9) {
    // 자정~08:59는 전날 근무일로 취급 — UTC 기준 연산으로 월/년 경계 자동 처리
    const rolled = new Date(Date.UTC(y, m - 1, day - 1));
    y   = rolled.getUTCFullYear();
    m   = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  const p2 = n => String(n).padStart(2, "0");
  return `${y}-${p2(m)}-${p2(day)}`;
}

function wlInit() {
  wlCenter = currentUser.center_name === "Master"
    ? (document.getElementById("filter-center-event")?.value || "")
    : currentUser.center_name;
  if (!wlCenter) return;
  wlWorkday = wlGetWorkday(new Date());
  const el = document.getElementById("wl-today-str");
  if (el) el.textContent = `(${wlWorkday} 근무일)`;
  const titleEl = document.getElementById("wl-title-text");
  if (titleEl) titleEl.textContent = `${wlCenter} ${WL_TITLE_SUFFIX}`;
  // 날짜 입력칸 기본값 = 오늘 근무일 (Firestore에 저장된 값이 있으면 onSnapshot이 곧 덮어씀)
  const dateEl = document.getElementById("date_input");
  if (dateEl && !dateEl.value) dateEl.value = wlWorkday;
  wlSubscribe();
  wlInitMonthPanel();
  wlAttendanceLoaded = null; // 센터 전환 시 출근부 미리보기 캐시 무효화 (다음에 탭 열면 새로 로드)
  wlSwitchSubTab("diary");   // 센터 전환 시 항상 근무일지 화면으로 리셋
}

// ──────────────────────────────────────────────
// 근무일지 / 출근부 서브탭 전환
// ──────────────────────────────────────────────
function wlSwitchSubTab(tab) {
  document.querySelectorAll('.event-toolbar .sub-tab[data-wltab]').forEach(el =>
    el.classList.toggle("active", el.dataset.wltab === tab));
  const diaryEl = document.getElementById("wl-subpage-diary");
  const attEl   = document.getElementById("wl-subpage-attendance");
  if (diaryEl) diaryEl.style.display = tab === "diary" ? "flex" : "none";
  if (attEl)   attEl.style.display   = tab === "attendance" ? "block" : "none";
  const saveBtn = document.getElementById("wl-save-btn");
  if (saveBtn) saveBtn.style.display = tab === "diary" ? "" : "none";
  if (tab === "attendance") wlLoadAttendancePreview();
}

// ──────────────────────────────────────────────
// 근무일지: 월별 점검표 다운로드 박스 (1~12월)
// ──────────────────────────────────────────────
let wlDownloadYear = null;

function wlInitMonthPanel() {
  // 첫 진입 시에만 연도를 오늘 기준으로 세팅 (연도 이동 후 재호출돼도 유지되도록)
  if (wlDownloadYear === null) wlDownloadYear = new Date().getFullYear();
  wlRenderMonthPanel();
}

function wlChangeYear(delta) {
  wlDownloadYear += delta;
  wlRenderMonthPanel();
}

// Storage에서 work_log/{center}/{year}년_{m}월_점검표.xlsx 12개월치 존재 여부를 병렬 확인.
// 존재하는 달(=지금까지 workLogDailyExport가 시트를 채워 넣은 달)만 다운로드 가능하게 표시.
// ※ 진행 중인 달은 오늘까지 작성된 날짜의 시트만 들어있는 "부분 완성" 파일이 정상 동작임
//   (예: 7월 8일에 다운로드하면 7월 7일 시트까지만 존재 — workLogDailyExport가 매일 09:00에
//   전날 시트를 추가하는 구조이므로 당연한 결과)
async function wlRenderMonthPanel() {
  const label = document.getElementById("wl-month-year-label");
  if (label) label.textContent = `${wlDownloadYear}년`;
  const grid = document.getElementById("wl-month-grid");
  if (!grid || !wlCenter) return;

  grid.innerHTML = Array.from({ length: 12 }, (_, i) =>
    `<div class="wl-month-box" data-month="${i + 1}">${i + 1}월</div>`).join("");

  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
      const path = `work_log/${wlCenter}/${wlDownloadYear}년_${m}월_점검표.xlsx`;
      return storage.ref(path).getDownloadURL().then(url => ({ m, url }));
    })
  );

  results.forEach(r => {
    if (r.status !== "fulfilled") return; // 파일 없음(storage/object-not-found) → 회색 박스 그대로 둠
    const box = grid.querySelector(`.wl-month-box[data-month="${r.value.m}"]`);
    if (!box) return;
    box.classList.add("available");
    box.title = "클릭해서 다운로드";
    box.addEventListener("click", () => window.open(r.value.url, "_blank"));
  });
}

function wlSubscribe() {
  wlUnsubs.forEach(u => u());
  wlUnsubs = [];
  wlBaseSynced = {}; // 센터/근무일 전환 시 이전 문서 기준값 초기화 (다른 문서와 뒤섞이지 않도록)

  const docId = `${wlCenter}_${wlWorkday}`;
  wlBaseDocRef = db.collection("work_logs").doc(docId);

  // 단일값 필드(인원현황/서명/날씨) 구독
  wlUnsubs.push(wlBaseDocRef.onSnapshot(snap => {
    const data = snap.exists ? snap.data() : {};
    for (const fid of WL_SINGLE_FIELDS) {
      const inp = document.getElementById(fid);
      const val = data[fid] !== undefined ? data[fid] : "";
      wlBaseSynced[fid] = val; // 다른 컴퓨터가 쓴 값을 "동기화된 기준값"으로 항상 갱신
      if (inp && data[fid] !== undefined && document.activeElement !== inp) inp.value = data[fid];
    }
  }, e => console.error("[근무일지] 기본정보 구독 오류:", e)));
  wlBindBaseFieldAutosave();

  // 줄 단위 섹션 6개 구독
  for (const key of Object.keys(WL_SECTIONS)) {
    const sub = WL_SECTIONS[key].sub;
    const unsub = wlBaseDocRef.collection(sub).orderBy("created_at","asc").onSnapshot(snap => {
      wlState[key] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      wlRenderSection(key);
    }, e => console.error(`[근무일지] ${key} 구독 오류:`, e));
    wlUnsubs.push(unsub);
  }
}

// 본인 글 또는 관리자만 수정 가능
function wlCanEdit(entry) {
  if (!entry) return true; // 아직 없는(빈) 슬롯 → 누구나 새로 작성 가능
  if (currentUser.active === true || currentUser.center_name === "Master") return true;
  return entry.created_by === currentUser.name;
}

// 심플 섹션(작업내용 한 줄짜리: dayWork/dayCheck/nightWork/nightNote) 렌더링
function wlRenderSimpleSection(key) {
  const meta = WL_SECTIONS[key];
  const entries = wlState[key];
  meta.fids.forEach((fid, i) => {
    const inp = document.getElementById(fid);
    if (!inp) return;
    const td = inp.closest("td");
    const entry = entries[i];
    if (entry) {
      inp.value = entry.content || "";
      const editable = wlCanEdit(entry);
      inp.readOnly = !editable;
      td.classList.toggle("wl-locked", !editable);
      td.classList.toggle("wl-locked-admin", editable && entry.created_by !== currentUser.name);
      td.classList.remove("wl-active");
      inp.title = `작성: ${entry.created_by||""}` + (entry.edited_by && entry.edited_by!==entry.created_by ? ` · 수정: ${entry.edited_by}` : "");
      inp.onblur = editable ? () => wlSaveLine(key, i, inp.value) : null;
    } else if (i === entries.length) {
      inp.value = "";
      inp.readOnly = false;
      td.classList.remove("wl-locked","wl-locked-admin");
      td.classList.add("wl-active");
      inp.title = "";
      inp.onblur = () => { if (inp.value.trim()) wlSaveLine(key, i, inp.value); };
    } else {
      inp.value = "";
      inp.readOnly = true;
      td.classList.remove("wl-active","wl-locked-admin");
      td.classList.add("wl-locked");
      inp.title = "";
      inp.onblur = null;
    }
  });
}

// 법정점검 / 자재입출고(여러 하위 필드짜리) 렌더링
function wlRenderMultiSection(key) {
  const meta = WL_SECTIONS[key];
  const entries = wlState[key];
  meta.rows.forEach((rowFids, i) => {
    const entry = entries[i];
    const editable = entry ? wlCanEdit(entry) : true;
    const isNext = !entry && i === entries.length;
    Object.keys(rowFids).forEach(sub => {
      const fid = rowFids[sub];
      const inp = document.getElementById(fid);
      if (!inp) return;
      const td = inp.closest("td");
      if (entry) {
        inp.value = entry[sub] || "";
        inp.readOnly = !editable;
        td.classList.toggle("wl-locked", !editable);
        td.classList.toggle("wl-locked-admin", editable && entry.created_by !== currentUser.name);
        td.classList.remove("wl-active");
        inp.onblur = editable ? () => wlSaveMultiLine(key, i, rowFids) : null;
      } else if (isNext) {
        inp.value = "";
        inp.readOnly = false;
        td.classList.remove("wl-locked","wl-locked-admin");
        td.classList.add("wl-active");
        inp.onblur = () => wlSaveMultiLine(key, i, rowFids);
      } else {
        inp.value = "";
        inp.readOnly = true;
        td.classList.add("wl-locked");
        td.classList.remove("wl-active","wl-locked-admin");
        inp.onblur = null;
      }
    });
  });
}

function wlRenderSection(key) {
  if (WL_SECTIONS[key].kind === "simple") wlRenderSimpleSection(key);
  else wlRenderMultiSection(key);
}

// 심플 섹션 한 줄 저장 (새 줄 추가 or 기존 줄 수정)
async function wlSaveLine(key, idx, value) {
  if (!value || !value.trim()) return;
  const meta = WL_SECTIONS[key];
  const entries = wlState[key];
  const sub = wlBaseDocRef.collection(meta.sub);
  try {
    if (entries[idx]) {
      await sub.doc(entries[idx].id).update({
        content: value.trim(),
        edited_by: currentUser.name,
        edited_at: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await sub.add({
        content: value.trim(),
        created_by: currentUser.name,
        created_at: firebase.firestore.FieldValue.serverTimestamp(),
        edited_by: currentUser.name,
        edited_at: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (e) {
    console.error(`[근무일지] ${key} 저장 실패:`, e);
    alert("저장 중 오류가 발생했습니다.");
  }
}

// 멀티필드 섹션(법정점검/자재입출고) 한 줄 저장
async function wlSaveMultiLine(key, idx, rowFids) {
  const meta = WL_SECTIONS[key];
  const entries = wlState[key];
  const sub = wlBaseDocRef.collection(meta.sub);
  const payload = {};
  let hasValue = false;
  for (const subKey of Object.keys(rowFids)) {
    const inp = document.getElementById(rowFids[subKey]);
    payload[subKey] = inp ? inp.value.trim() : "";
    if (payload[subKey]) hasValue = true;
  }
  if (!hasValue) return;
  try {
    if (entries[idx]) {
      await sub.doc(entries[idx].id).update({
        ...payload,
        edited_by: currentUser.name,
        edited_at: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await sub.add({
        ...payload,
        created_by: currentUser.name,
        created_at: firebase.firestore.FieldValue.serverTimestamp(),
        edited_by: currentUser.name,
        edited_at: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (e) {
    console.error(`[근무일지] ${key} 저장 실패:`, e);
    alert("저장 중 오류가 발생했습니다.");
  }
}

// 단일필드 blur 자동저장 리스너 바인딩 (최초 1회) — 줄 단위 항목과 동일하게 필드 하나만 저장
// (기존에는 "저장" 버튼 클릭 시 26개 필드 전체를 현재 화면 값으로 통째로 merge-write 했기 때문에,
//  다른 컴퓨터가 아직 화면에 못 받은/건드리지 않은 필드까지 빈 값으로 덮어써 데이터가 사라지는
//  문제가 있었음. 필드별로 "실제 바뀐 값만" 저장하도록 변경.)
function wlBindBaseFieldAutosave() {
  if (wlBaseFieldsBound) return;
  wlBaseFieldsBound = true;
  WL_SINGLE_FIELDS.forEach(fid => {
    const inp = document.getElementById(fid);
    if (!inp) return;
    inp.addEventListener("blur", () => wlSaveBaseField(fid, inp.value));
  });
}

// 단일필드 1개 저장 (값이 실제로 바뀐 경우에만 Firestore에 반영)
async function wlSaveBaseField(fid, value) {
  if (!wlBaseDocRef) return;
  if (wlBaseSynced[fid] === value) return; // 변경 없음 → 불필요한 쓰기 스킵
  try {
    await wlBaseDocRef.set({
      [fid]: value,
      center_name: wlCenter,
      workday: wlWorkday,
      updated_at: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    wlBaseSynced[fid] = value; // 낙관적 갱신 (곧 onSnapshot으로 재확정됨)
  } catch (e) {
    console.error(`[근무일지] ${fid} 저장 실패:`, e);
    alert("저장 중 오류가 발생했습니다.");
  }
}

// 기본정보 "저장" 버튼 — blur를 안 거치고 남아있는 변경분(예: Enter로 넘어간 필드)을 한 번에 반영.
// ※ 반드시 wlBaseSynced와 다른(=실제로 바뀐) 필드만 payload에 담아, 다른 컴퓨터가 쓴 값을
//   덮어쓰지 않도록 함.
async function wlSaveBaseInfo() {
  if (!wlBaseDocRef) return;
  const payload = {};
  let hasChange = false;
  for (const fid of WL_SINGLE_FIELDS) {
    const inp = document.getElementById(fid);
    if (!inp) continue;
    if (wlBaseSynced[fid] !== inp.value) { payload[fid] = inp.value; hasChange = true; }
  }
  if (!hasChange) { alert("변경된 내용이 없습니다."); return; }
  payload.center_name = wlCenter;
  payload.workday = wlWorkday;
  payload.updated_at = firebase.firestore.FieldValue.serverTimestamp();
  try {
    await wlBaseDocRef.set(payload, { merge: true });
    for (const fid of WL_SINGLE_FIELDS) {
      if (fid in payload) wlBaseSynced[fid] = payload[fid];
    }
    alert("기본정보가 저장되었습니다.");
  } catch (e) {
    console.error("[근무일지] 기본정보 저장 실패:", e);
    alert("저장 중 오류가 발생했습니다.");
  }
}

// ──────────────────────────────────────────────
// 출근부 원본 미리보기 (templates/{center}/work_seet.xlsx 를 그대로 표시, 읽기 전용)
// SheetJS(XLSX)로 클라이언트에서 직접 파싱 — 서버 왕복 없이 바로 렌더링
// ──────────────────────────────────────────────
let wlAttendanceLoaded = null; // 캐시 키: `${center}_${year}-${month}` — 같은 달이면 재조회 안 함

async function wlLoadAttendancePreview() {
  if (!wlCenter) return;
  const statusEl = document.getElementById("wl-attendance-status");
  const wrap     = document.getElementById("wl-attendance-table-wrap");

  const kst = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const year = parseInt(kst.year, 10), month = parseInt(kst.month, 10), day = parseInt(kst.day, 10);

  const cacheKey = `${wlCenter}_${year}-${month}`;
  if (wlAttendanceLoaded === cacheKey) return; // 이미 로드된 상태 — 새로고침 버튼 누르면 캐시 비우고 재호출됨

  statusEl.textContent = "출근부 불러오는 중...";
  wrap.innerHTML = "";

  try {
    const path = `templates/${wlCenter}/work_seet.xlsx`;
    const url  = await storage.ref(path).getDownloadURL();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`파일 다운로드 실패: ${resp.status}`);
    const buf  = await resp.arrayBuffer();
    const wb   = XLSX.read(buf, { type: "array" });

    // 시트명이 "7월"/"07월" 등으로 다를 수 있어 이름으로 먼저 찾고, 안되면 첫 시트 사용
    const sheetName = wb.SheetNames.find(n => n.replace(/\s/g, "") === `${month}월`)
      || wb.SheetNames.find(n => n.replace(/\s/g, "") === `${String(month).padStart(2, "0")}월`)
      || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });

    wrap.innerHTML = wlRenderAttendanceTable(rows, day, ws["!merges"]);
    wlStickyHeaderOffsets(wrap); // 헤더가 여러 줄이라 행마다 top 오프셋을 실측해서 스택되게 함
    statusEl.textContent = `"${sheetName}" 시트 · 원본 그대로 표시 (읽기 전용) · 오늘(${day}일) 열 강조`;
    wlAttendanceLoaded = cacheKey;
  } catch (e) {
    console.warn("[출근부 미리보기] 로드 실패:", e.code || e.message || e);
    statusEl.textContent = "";
    wrap.innerHTML = `<div class="empty-state"><div class="icon">📋</div><p>출근부 파일이 없습니다.<br><span style="font-size:12px">(templates/${esc(wlCenter)}/work_seet.xlsx 확인 필요)</span></p></div>`;
  }
}

// ──────────────────────────────────────────────
// 출근부 원본 업로드 (관리자/Master 전용) — 매월 work_seet.xlsx 교체
// 파일 선택 → 로컬 검증(이름/확장자/시트명) → 미리보기 확인 → "업로드" 클릭 시 Storage 반영
// ──────────────────────────────────────────────
let wlPendingAttendanceFile = null; // 검증 통과 후 업로드 대기 중인 File 객체

// 파일 선택 직후 — 이름/확장자/시트명만 로컬에서 검증. 통과 전까지 Storage에는 아무 것도 안 올라감.
async function wlValidateAttendanceFile(file) {
  const inputEl = document.getElementById("wl-attendance-upload-input");
  if (!file) return;

  // 1. 확장자 검증
  if (!/\.xlsx$/i.test(file.name)) {
    alert(`확장자가 올바르지 않습니다.\n선택한 파일: "${file.name}"\n반드시 .xlsx 파일이어야 합니다.`);
    inputEl.value = "";
    return;
  }

  // 2. 파일명(확장자 제외) 검증 — 정확히 "work_seet" 이어야 함
  const baseName = file.name.replace(/\.xlsx$/i, "");
  if (baseName !== "work_seet") {
    alert(`파일 이름이 올바르지 않습니다.\n선택한 파일: "${file.name}"\n파일명이 정확히 "work_seet.xlsx" 이어야 합니다.\n(현재 이름: "${baseName}")`);
    inputEl.value = "";
    return;
  }

  // 3. 시트 이름 검증 — "양식" 또는 이번 달("N월") 시트가 하나라도 있어야 통과
  let wb;
  try {
    const buf = await file.arrayBuffer();
    wb = XLSX.read(buf, { type: "array" });
  } catch (e) {
    alert("엑셀 파일을 읽을 수 없습니다. 파일이 손상되었거나 xlsx 형식이 아닐 수 있습니다.");
    inputEl.value = "";
    return;
  }

  const kst = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "2-digit" })
    .formatToParts(new Date()).find(p => p.type === "month").value;
  const month = parseInt(kst, 10);
  const validSheetNames = ["양식", `${month}월`, `${String(month).padStart(2, "0")}월`];

  const matchedSheet = wb.SheetNames.find(n => validSheetNames.includes(n.replace(/\s/g, "")));
  if (!matchedSheet) {
    alert(`시트 이름을 확인해주세요.\n"양식" 또는 "${month}월" 시트가 있어야 합니다.\n\n파일 안 시트 목록: ${wb.SheetNames.join(", ")}`);
    inputEl.value = "";
    return;
  }

  // 검증 통과 — 업로드 대기 상태로 전환, 엑셀 아이콘 + 파일명 미리보기 표시
  wlPendingAttendanceFile = file;
  document.getElementById("wl-attendance-pending-name").textContent = file.name;
  document.getElementById("wl-attendance-pending-info").textContent =
    `${(file.size / 1024).toFixed(0)} KB · "${matchedSheet}" 시트 확인됨`;
  document.getElementById("wl-attendance-pending").style.display = "flex";
}

function wlCancelAttendanceUpload() {
  wlPendingAttendanceFile = null;
  document.getElementById("wl-attendance-pending").style.display = "none";
  document.getElementById("wl-attendance-upload-input").value = "";
}

// "이 파일로 업로드" 버튼 — 실제 Storage 반영. 같은 경로 put()이라 기존 파일은 자동 덮어쓰기됨 (별도 delete 불필요).
async function wlUploadAttendanceTemplate() {
  const file = wlPendingAttendanceFile;
  if (!file || !wlCenter) return;

  if (!confirm(`"${wlCenter}" 센터의 출근부 양식을 교체합니다.\n기존 파일은 삭제되고 새 파일로 덮어씌워지며, 되돌릴 수 없습니다.\n계속하시겠습니까?`)) {
    return;
  }

  const statusEl = document.getElementById("wl-attendance-status");
  statusEl.textContent = "업로드 중...";

  try {
    const path = `templates/${wlCenter}/work_seet.xlsx`;
    await storage.ref(path).put(file, {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    alert("출근부 양식이 업로드되었습니다.");
    wlCancelAttendanceUpload();
    wlAttendanceLoaded = null;       // 미리보기 캐시 무효화
    await wlLoadAttendancePreview(); // 새 파일로 미리보기 재조회
  } catch (e) {
    console.error("[출근부 업로드] 실패:", e);
    alert("업로드 중 오류가 발생했습니다: " + (e.message || e.code || e));
    statusEl.textContent = "";
  }
}

// 시트를 2차원 배열(rows)로 받아 HTML 표로 렌더링.
// - merges(ws['!merges'])를 살려서 colspan/rowspan으로 실제 병합 셀을 그대로 재현
//   → 병합 헤더 셀(예: "주간·야간:사인(서명)")이 좁은 칸 하나를 억지로 넓히면서
//     아래 날짜 칸들과 열 폭이 어긋나는 문제를 해결
// - 날짜 숫자 행을 찾아 그 다음 행(요일 행)까지를 "헤더 구간", 그 이후를 "데이터 구간"으로 분류해
//   서로 다른 배경/글자색/격자색을 적용하고, 오늘 날짜 열은 구간별로 다른 톤으로 강조
function wlRenderAttendanceTable(rows, todayDay, merges) {
  if (!rows || rows.length === 0) {
    return `<div class="empty-state"><p>표시할 데이터가 없습니다.</p></div>`;
  }

  // 날짜 숫자 행(예: 1,2,3...31)과 그 안에서 오늘에 해당하는 열을 찾음
  let todayRow = -1, todayCol = -1;
  for (let r = 0; r < rows.length; r++) {
    const idx = rows[r].findIndex(v => String(v).trim() !== "" && Number(String(v).trim()) === todayDay);
    if (idx > -1) { todayRow = r; todayCol = idx; break; }
  }
  // 날짜 행 다음 줄이 요일 행 — 각 행 타입은 아래 렌더링 루프에서 todayRow 기준으로 직접 판정

  // 병합 셀 맵 구성: 좌상단 셀엔 colspan/rowspan, 나머지 셀은 렌더링 스킵
  const mergeMap = {};
  (merges || []).forEach(m => {
    const rspan = m.e.r - m.s.r + 1;
    const cspan = m.e.c - m.s.c + 1;
    if (rspan === 1 && cspan === 1) return;
    mergeMap[`${m.s.r},${m.s.c}`] = { rowspan: rspan, colspan: cspan };
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r === m.s.r && c === m.s.c) continue;
        mergeMap[`${r},${c}`] = { skip: true };
      }
    }
  });

  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  let html = '<table class="wl-att-table"><tbody>';
  rows.forEach((row, r) => {
    // 날짜행/요일행은 todayRow 기준으로 정확히 특정, 그 위는 전부 "제목행", 아래는 "데이터행"
    let rowType;
    if (todayRow === -1)      rowType = r === 0 ? "wl-att-title" : "wl-att-data";
    else if (r < todayRow)    rowType = "wl-att-title";
    else if (r === todayRow)  rowType = "wl-att-date";
    else if (r === todayRow + 1) rowType = "wl-att-day";
    else                       rowType = "wl-att-data";

    html += `<tr class="${rowType}">`;
    for (let c = 0; c < maxCols; c++) {
      const info = mergeMap[`${r},${c}`];
      if (info && info.skip) continue; // 병합에 가려진 칸은 렌더링 스킵

      const v = row[c] !== undefined ? row[c] : "";
      const span = info ? ` colspan="${info.colspan || 1}" rowspan="${info.rowspan || 1}"` : "";
      const todayCls = c === todayCol ? " wl-att-today" : "";
      html += `<td class="${todayCls.trim()}"${span}>${esc(v)}</td>`;
    }
    html += "</tr>";
  });
  html += "</tbody></table>";
  return html;
}

// 헤더가 여러 줄이라 각 행마다 sticky top 오프셋이 달라야 스택되어 고정됨.
// 실제 렌더된 행 높이를 재서 누적 top을 넣어줌 (센터마다 헤더 줄 수가 달라도 안전하게 동작).
function wlStickyHeaderOffsets(wrap) {
  requestAnimationFrame(() => {
    const headerRows = wrap.querySelectorAll("tr.wl-att-title, tr.wl-att-date, tr.wl-att-day");
    let top = 0;
    headerRows.forEach(tr => {
      tr.querySelectorAll("td").forEach(td => { td.style.top = `${top}px`; });
      top += tr.getBoundingClientRect().height;
    });
  });
}

// ──────────────────────────────────────────────
// 근무일지 표: Enter = 아래 칸 이동, 아래가 없거나 잠겨있으면 Tab과 동일하게 다음 칸 이동
// ──────────────────────────────────────────────
(function wlSetupEnterNavigation() {
  const table = document.querySelector("table.wl-sheet");
  if (!table) return;

  table.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const inp = e.target;
    if (!inp || inp.tagName !== "INPUT") return;
    e.preventDefault(); // 폼이 없어서 원래도 제출은 안 되지만, 브라우저 기본 동작(달력 열림 등) 방지

    // 1) id 끝 숫자만 +1 한 "같은 컬럼 아래 칸" 먼저 시도
    const m = inp.id.match(/^(.*_)(\d+)$/);
    if (m) {
      const nextId  = `${m[1]}${parseInt(m[2], 10) + 1}`;
      const nextInp = document.getElementById(nextId);
      if (nextInp && !nextInp.readOnly && !nextInp.disabled) {
        nextInp.focus();
        nextInp.select?.();
        return;
      }
    }

    // 2) 아래 칸이 없거나(마지막 행) 잠겨있으면 → Tab과 동일하게 표 안의 다음 입력칸으로
    const all = Array.from(table.querySelectorAll("input"));
    const idx = all.indexOf(inp);
    for (let i = idx + 1; i < all.length; i++) {
      if (!all[i].disabled) {
        all[i].focus();
        all[i].select?.();
        return;
      }
    }
  });
})();


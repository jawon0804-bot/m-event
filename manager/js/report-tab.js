// ──────────────────────────────────────────────
// 보고서 탭: 이벤트 / 점검표 서브탭 전환
// ──────────────────────────────────────────────
function reportSwitchSubTab(tab) {
  document.querySelectorAll('#page-report .sub-tab[data-reporttab]').forEach(el =>
    el.classList.toggle("active", el.dataset.reporttab === tab));
  const eventEl = document.getElementById("report-subpage-event");
  const inspEl  = document.getElementById("report-subpage-inspection");
  if (eventEl) eventEl.style.display = tab === "event" ? "block" : "none";
  if (inspEl)  inspEl.style.display  = tab === "inspection" ? "block" : "none";
  if (tab === "inspection") {
    const monthInput = document.getElementById("filter-month-report-insp");
    if (monthInput && !monthInput.value) monthInput.value = prevMonthStr();
  }
}

function prevMonthStr() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ──────────────────────────────────────────────
// 점검표 현황 — 회차(엑셀 1개 = 1회차)와 설비(fid) 두 단계로 집계한다.
//
// 점검표 행 : center_configs/{center}/inspections 기준. 기대=도래한 회차 수,
//             실제=Maxerve_Excel 생성 건수(= "매핑된" 횟수).
// 설비 행   : 점검표를 펼치면 나오는 fid별 행. 기대는 같고,
//             실제=inspection_logs 기준 실제로 점검된 회차 수.
// ⚠️ 그래서 **설비 행의 실제를 더해도 점검표 행의 실제와 같지 않다** — 축이 다르다
//    (점검표=엑셀 생성 / 설비=현장 점검). 둘이 어긋나는 게 오히려 보고 싶은 정보다:
//    설비가 전부 완료인데 점검표 실제가 0이면 "점검은 다 됐는데 매핑이 안 된 것"이다.
//
// 왜 설비 단위가 필요한가: M-Engine은 fids 중 **하나라도** 로그가 없으면 엑셀을
// 아예 안 만든다(M-Engine/lib/excel_engine.py의 `점검 누락: N개 미완료` 분기).
// 그 "몇 개 완료 / 몇 개 누락"은 Cloud Run 로그로만 나가고 Firestore엔 안 남아서,
// 예전 화면은 "0건 부족"까지만 보이고 원인을 알 수 없었다.
// (2026-07-26에 누락 메일도 없앴으므로 지금은 이 화면이 유일한 확인 경로다.)
// ──────────────────────────────────────────────

// M-Engine lib/config.py의 BUSINESS_DAY_START_HOUR = 6 과 같은 값이어야 한다.
// 일일 점검표의 하루는 자정이 아니라 "06:00 ~ 익일 06:00"이다(엔진 종류 무관).
const INSP_BUSINESS_DAY_START = "06:00";

const _p2 = n => String(n).padStart(2, "0");

// (y, m, d)에서 delta일 이동한 날짜를 "YYYY-MM-DD"로. UTC 연산이라 월/년 경계가 자동 처리된다.
function inspShiftDate(y, m, d, delta) {
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${_p2(t.getUTCMonth() + 1)}-${_p2(t.getUTCDate())}`;
}

// 지금 시각을 KST 벽시계 "YYYY-MM-DD HH:MM"으로. inspection_logs.datetime이 같은 형식의
// KST 문자열이라, 문자열끼리 비교하면 타임존 변환 없이 회차 귀속이 정확히 맞는다
// (M-Engine도 Firestore에 같은 문자열 비교로 질의한다). toLocaleString() 파싱은
// 브라우저/OS 로캘을 타서 안 쓴다 — worklog.js의 wlGetWorkday 주석 참고.
function inspNowKst() {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).reduce((acc, x) => (acc[x.type] = x.value, acc), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// 그 달에 생성됐어야 할 회차 목록. 각 회차는 [start, end) 문자열 구간을 갖는다.
// 길이는 M-Engine lib/scheduler.py의 calc_expected_count()와 항상 같아야 한다
// (daily=그 달 일수, weekly=그 달 월요일 수, monthly=1). 구간의 근거는 같은 파일의
// calc_schedule_dates(): weekly는 월요일에 "지난주 월~일"을, monthly는 그 달 1일~말일을 만든다.
function buildInspPeriods(scheduleType, year, month) {
  const dim = new Date(year, month, 0).getDate(); // month: 1~12
  const out = [];
  if (scheduleType === "daily") {
    for (let d = 1; d <= dim; d++) {
      const day = `${year}-${_p2(month)}-${_p2(d)}`;
      out.push({
        label: day,
        start: `${day} ${INSP_BUSINESS_DAY_START}`,
        end:   `${inspShiftDate(year, month, d, 1)} ${INSP_BUSINESS_DAY_START}`,
      });
    }
  } else if (scheduleType === "monthly") {
    out.push({
      label: `${year}-${_p2(month)}`,
      start: `${year}-${_p2(month)}-01 00:00`,
      end:   `${inspShiftDate(year, month, dim, 1)} 00:00`,
    });
  } else if (scheduleType === "weekly") {
    for (let d = 1; d <= dim; d++) {
      if (new Date(year, month - 1, d).getDay() !== 1) continue; // 1 = 월요일(생성일)
      const lastMon = inspShiftDate(year, month, d, -7);
      out.push({
        label: `${lastMon}~${inspShiftDate(year, month, d, -1)}`,
        start: `${lastMon} 00:00`,
        end:   `${year}-${_p2(month)}-${_p2(d)} 00:00`,
      });
    }
  }
  return out; // daily/weekly/monthly 외 타입은 빈 배열 → 집계 대상 아님
}

// results 필드에서 첫 값만 꺼낸다. V8(전기 일지)은 이 값이 시간대 라벨("10:00" 등)이다.
// 신포맷([{label,value}]) / 구포맷("정상,25도" 콤마 문자열) 둘 다 처리 —
// M-Engine processor.py의 parse_results()와 같은 규칙.
function inspFirstResult(raw) {
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (first && typeof first === "object") return String(first.value ?? "").trim();
    return String(first ?? "").trim();
  }
  return String(raw ?? "").split(",")[0].trim();
}

// Maxerve_Excel의 storage_path에서 func_key를 되뽑는다.
// 경로 형식: excel/{center}/{center}_{func_key}_{YYYY-MM-DD}[M].xlsx
//   (뒤의 M은 수동 트리거 표시 — M-Engine lib/excel_engine.py의 output_filename)
// center_name으로 접두사를 떼고 마지막 밑줄 뒤(날짜)를 떼는 방식이라, func_key에
// 밑줄이 있어도(BOOSTER_PUMP) 센터명에 밑줄이 있어도 안전하다.
// 판정 불가면 빈 문자열 — 호출부가 예전 방식(facility_id 매칭)으로 폴백한다.
//
// ⚠️ M-Engine lib/scheduler.py의 func_key_from_storage_path()와 **같은 규칙**이다.
//    한쪽을 고치면 반드시 다른 쪽도 고칠 것 — 화면과 월간 메일이 갈린다.
//    양쪽 테스트가 같은 케이스 표를 쓴다(tests/func-key.test.js ↔ tests/test_func_key.py).
function inspFuncKeyFromPath(storagePath, centerName) {
  const path = String(storagePath ?? "");
  const center = String(centerName ?? "");
  if (!path || !center) return "";
  let name = path.split("/").pop();
  if (name.endsWith(".xlsx")) name = name.slice(0, -".xlsx".length);
  const prefix = center + "_";
  if (!name.startsWith(prefix)) return "";
  const rest = name.slice(prefix.length);
  const cut = rest.lastIndexOf("_");
  if (cut <= 0) return "";
  return rest.slice(0, cut);
}

// Maxerve_Excel 문서 1건이 어느 점검표에서 나왔는지. 없으면 빈 문자열.
function inspDocFuncKey(data) {
  const fk = String(data.func_key ?? "").trim();
  if (fk) return fk;
  return inspFuncKeyFromPath(data.storage_path, data.center_name);
}

function setInspReportMsg(text, type) {
  const el = document.getElementById("report-insp-status-msg");
  el.textContent = text || "";
  el.className = "report-status-msg" + (type ? ` ${type}` : "");
}

// 상태 뱃지. 점검표 행과 설비 행은 **축이 다르다** —
//   점검표 행(매핑 축) : 엑셀이 만들어졌는가. 월말에 만들어지므로 그전엔 "진행중"이 맞다.
//   설비 행(점검 축)   : 현장에서 점검했는가. **기간이 안 끝났어도 했으면 "완료"다.**
// 이 둘을 하나로 섞어놨다가 "8/13에 점검을 끝낸 저수조설비가 진행중으로 보이는" 문제가 있었다.
function inspBadge(kind, title) {
  const [bg, color, text] = {
    // 점검표 행
    ok:       ["#dcfce7", "#15803d", "정상"],
    short:    ["#fee2e2", "#dc2626", "⚠️ 부족"],
    unmapped: ["#ffedd5", "#c2410c", "미매핑"],
    pending:  ["#f1f5f9", "#475569", "진행중"],
    // 설비 행
    done:     ["#dcfce7", "#15803d", "완료"],
    missing:  ["#fee2e2", "#dc2626", "⚠️ 미완료"],
    waiting:  ["#f1f5f9", "#475569", "대기"],
  }[kind];
  const tip = title ? ` title="${title}"` : "";
  return `<span class="insp-badge" style="background:${bg};color:${color}"${tip}>${text}</span>`;
}

// "2026-08-15 14:50" → "08-15 14:50" (연도는 조회한 달로 이미 정해져 있어 군더더기)
function inspShortDt(dt) {
  const s = String(dt || "");
  return s.length >= 16 ? s.slice(5, 16) : s;
}

// 점검표 행 클릭 → 설비 행 펼치기/접기
function toggleInspDetail(idx) {
  const rows = document.querySelectorAll(`#report-insp-table tr[data-parent="${idx}"]`);
  if (!rows.length) return;
  const open = !rows[0].classList.contains("show");
  rows.forEach(r => r.classList.toggle("show", open));
  const caret = document.getElementById(`insp-caret-${idx}`);
  if (caret) caret.textContent = open ? "▾" : "▸";
}

async function loadInspectionReport() {
  const center = document.getElementById("filter-center-report-insp").value ||
    (currentUser.center_name !== "Master" ? currentUser.center_name : "");
  const month = document.getElementById("filter-month-report-insp").value;
  const btn   = document.getElementById("report-insp-load-btn");
  const card  = document.getElementById("report-insp-table-card");
  const tableEl = document.getElementById("report-insp-table");

  if (!center) { setInspReportMsg("센터를 선택하세요.", "error"); return; }
  if (!month)  { setInspReportMsg("월을 선택하세요.", "error"); return; }

  btn.disabled = true;
  setInspReportMsg("");
  card.style.display = "none";
  try {
    const [year, monthNum] = month.split("-").map(Number);
    const dim = new Date(year, monthNum, 0).getDate();

    // Master가 센터를 바꿨으면 그 센터의 설비 이름표(fid_name)를 다시 읽는다
    // (photo-tab.js의 loadDashPhotos와 같은 처리 — 안 하면 남의 센터 이름이 남는다)
    if (currentUser.center_name === "Master") await loadFidLocations(center);

    const inspectionsSnap = await db.collection("center_configs").doc(center).collection("inspections").get();
    if (inspectionsSnap.empty) {
      card.style.display = "block";
      tableEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>이 센터에 등록된 점검표가 없습니다.</p></div>`;
      return;
    }
    const snap = await db.collection("Maxerve_Excel")
      .where("center_name", "==", center)
      .where("datetime", ">=", month + "-01")
      .where("datetime", "<=", month + "-31￿")
      .get();

    // 생성 건수 집계. 기준은 func_key(점검표 문서 ID)다.
    // ⚠️ [2026-08-20] 예전엔 facility_id(= fids를 콤마로 이은 문자열)로만 셌다. 그런데
    //   그 문자열은 **생성 시점의 fids**라, 점검표 설정에서 설비를 하나 빼거나 더하면
    //   과거 생성분이 통째로 매칭에서 빠져 "0건 부족"으로 둔갑했다(집수정펌프가
    //   기계_41~47로 생성됐는데 설정이 기계_41~45로 바뀌어서, 파일이 멀쩡히 있는데도
    //   0건으로 보였다). func_key는 안 바뀌므로 그걸 정체성으로 쓴다.
    //   func_key를 못 뽑은 문서만 예전 방식으로 폴백한다.
    const actualByFuncKey = {}, actualByFid = {};
    snap.forEach(doc => {
      const data = doc.data();
      const fk = inspDocFuncKey(data);
      if (fk) {
        actualByFuncKey[fk] = (actualByFuncKey[fk] || 0) + 1;
      } else {
        const fid = data.facility_id || "";
        actualByFid[fid] = (actualByFid[fid] || 0) + 1;
      }
    });

    // 점검 원천 데이터. 조회 구간이 그 달보다 앞뒤로 넓은 이유:
    //   - 앞: weekly 회차는 "지난주 월~일"이라 그 달 첫 월요일 회차가 전월 말주를 가리킨다.
    //   - 뒤: daily 회차는 06:00 경계라 말일 회차가 익월 1일 06:00에 끝난다.
    // 조건(center_name 동등 + datetime 범위)은 이미 있는 복합 인덱스
    // (inspection_logs: center_name ASC, datetime ASC)가 그대로 처리한다 — 인덱스 추가 불필요.
    const logStart = `${inspShiftDate(year, monthNum, 1, -7)} 00:00`;
    const logEnd   = `${inspShiftDate(year, monthNum, dim, 1)} ${INSP_BUSINESS_DAY_START}`;
    const logSnap = await db.collection("inspection_logs")
      .where("center_name", "==", center)
      .where("datetime", ">=", logStart)
      .where("datetime", "<",  logEnd)
      .get();

    const logsByFid = {};
    logSnap.forEach(doc => {
      const d = doc.data();
      // 특이사항 메모는 점검이 아니다. M-Engine도 type != 'inspection'을 버린다
      // (lib/firestore_data.py). 실제 값은 'memo'가 아니라 'memo_only'이고 양이 적지 않다 —
      // 한 센터 7월 로그 151건 중 49건, 8월 47건 중 31건이 메모였다.
      if ((d.type || "inspection") !== "inspection") return;
      const fid = String(d.facility_id || "").trim();
      if (!fid) return;
      (logsByFid[fid] = logsByFid[fid] || []).push({
        dt: String(d.datetime || ""),
        t:  inspFirstResult(d.results),
        w:  String(d.worker || ""),
      });
    });

    const nowKst = inspNowKst();
    const typeOrder = { daily: 0, weekly: 1, monthly: 2 };
    const rows = [];
    inspectionsSnap.forEach(doc => {
      const insp = doc.data();
      if (insp.active === false) return;
      const stype = insp.schedule_type || "";
      const periodsAll = buildInspPeriods(stype, year, monthNum);
      if (periodsAll.length === 0) return; // daily/weekly/monthly 외 타입은 집계 대상 아님

      // [기대에서 미도래 회차 제외] 아직 끝나지 않은 회차는 "부족"이 아니라 아직 안 온 것이다.
      // 이 기준(회차 종료 <= 지금)은 M-Engine 스케줄과도 맞는다 — daily는 다음날 06:30에
      // 어제치를 만들고, monthly는 말일이 지나야 그 달이 닫힌다. 안 자르면 이번 달 조회는
      // 남은 날짜까지 미달로 잡혀 화면이 통째로 "부족"이 된다.
      //
      // ⚠️ 단, 완료 집계에서까지 빼면 안 된다. 진행 중인 회차에서 이미 한 점검이 통째로
      //    사라져서, 이번 달 monthly 점검을 벌써 끝낸 설비가 "0"으로 보인다(실제로 8월
      //    승강기가 그랬다). 그래서 분모(기대)만 도래분으로 자르고, 진행 중 회차의 완료는
      //    따로 세어 `+n`으로 같이 보여준다.
      const periods = periodsAll.filter(p => p.end <= nowKst);   // 도래(닫힌) 회차
      const pending = periodsAll.filter(p => p.end >  nowKst);   // 진행 중/미도래 회차
      const remain  = pending.length;

      const fids = (Array.isArray(insp.fids) ? insp.fids : []).map(f => String(f).trim());
      const fidStr = fids.join(",");
      const label = insp.sheet_label || insp.func_key || doc.id;
      // 점검표의 정체성은 문서 ID(=func_key)다. M-Engine도 이 ID로 config를 찾고
      // 파일명에 쓴다(fids와 달리 안 바뀐다).
      const funcKey = doc.id || insp.func_key || "";

      // V8(전기 일지)은 fid마다 time_rows의 시간대(10:00/15:00/20:00/24:00)가 **전부**
      // 있어야 그 회차가 완료다 — M-Engine processor.py의 select_v8_daily_data와 같은 규칙.
      // 하나라도 빠지면 로그가 있어도 미완료라, 0으로만 보이면 "점검을 아예 안 했다"로
      // 오해한다. 그래서 그런 회차 수(partial)를 따로 세서 △부분으로 표시한다.
      const isV8 = insp.engine_type === "V8";
      const needLabels = isV8 ? Object.keys(insp.time_rows || {}) : [];

      // 한 회차가 그 설비에 대해 완료됐는지 — 완료면 true, 로그는 있는데 V8 시간대가
      // 모자라면 "partial", 로그가 아예 없으면 false. 두 번째 값은 그 회차의 마지막 점검 기록.
      const slotState = (logs, p) => {
        const hits = logs.filter(l => l.dt >= p.start && l.dt < p.end);
        if (hits.length === 0) return [false, null];
        const last = hits.reduce((a, b) => (a.dt >= b.dt ? a : b));
        if (isV8 && needLabels.length) {
          const have = new Set(hits.map(h => h.t));
          if (!needLabels.every(n => have.has(n))) return ["partial", last];
        }
        return [true, last];
      };

      const fidRows = fids.map(fid => {
        const logs = logsByFid[fid] || [];
        let done = 0, partial = 0, donePending = 0, last = null;
        const see = (hit) => { if (hit && (!last || hit.dt > last.dt)) last = hit; };
        periods.forEach(p => {
          const [st, hit] = slotState(logs, p);
          see(hit);
          if (st === true) done++;
          else if (st === "partial") partial++;   // 도래한 회차만 △로 경고한다
        });
        // 아직 안 끝난 회차(이번 달 monthly 등)에서 한 점검도 **완료로 센다.**
        // 이 화면의 목적이 "이 설비 점검했나 안 했나"라서, 기간이 안 끝났다는 이유로
        // 이미 한 점검을 빼면 화면이 0으로 보인다(8월 승강기·저수조가 실제로 그랬다).
        pending.forEach(p => {
          const [st, hit] = slotState(logs, p);
          see(hit);
          if (st === true) donePending++;
        });
        return { fid, name: fidLocations[fid] || "", done, partial, donePending, last };
      });

      const doneSlots = fidRows.reduce((s, r) => s + r.done, 0);
      // 점검표 행의 "점검"은 **설비 × 회차 칸(슬롯)** 기준이다. 자식 행의 분자/분모를
      // 그대로 더한 값이라 펼쳤을 때 앞뒤가 맞는다 — 예전엔 점검표 행이 매핑 건수(0)를
      // 보여줘서 "0인데 펼치면 1개 완료"로 모순돼 보였다.
      // monthly는 회차가 1개라 슬롯 수 = 설비 수가 되어 "설비 10개 중 2개"로 읽힌다.
      const slotsDone  = fidRows.reduce((s, r) => s + r.done + r.donePending, 0);
      const slotsTotal = periodsAll.length * fids.length;
      const lastAny = fidRows.reduce((a, r) => (r.last && (!a || r.last.dt > a.dt) ? r.last : a), null);
      rows.push({
        stype, label, fidRows, remain, slotsDone, slotsTotal, lastAny,
        expected: periods.length,
        totalPeriods: periodsAll.length,
        count: (actualByFuncKey[funcKey] || 0) + (actualByFid[fidStr] || 0),
        allDone: periods.length > 0 && fids.length > 0 && doneSlots === periods.length * fids.length,
      });
    });
    rows.sort((a, b) => (typeOrder[a.stype] ?? 9) - (typeOrder[b.stype] ?? 9) || a.label.localeCompare(b.label));

    if (rows.length === 0) {
      card.style.display = "block";
      tableEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>daily/weekly/monthly 점검표가 없습니다.</p></div>`;
      return;
    }

    const html = `
      <p class="insp-report-legend">
        점검표 행을 누르면 설비별로 펼쳐집니다. <b>매핑</b>은 엑셀이 만들어진 건수,
        <b>점검</b>은 점검한 횟수(펼친 값의 합)입니다.
        엑셀은 보통 월말에 만들어져서 <b>점검이 끝나도 점검표 행은 한동안 진행중</b>입니다.
      </p>
      <div class="insp-report-scroll">
      <table class="insp-report-table">
        <thead><tr><th>구분</th><th>설비명</th><th>설비ID</th><th>매핑</th><th>점검</th><th>최근 점검</th><th>상태</th></tr></thead>
        <tbody>
          ${rows.map((r, i) => {
            // 점검표 행의 상태 = 매핑 축(엑셀이 만들어졌는가). 숫자 두 개는 축이 다르다:
            //   매핑 = 엑셀 몇 개 / 그 달 회차 몇 개
            //   점검 = 완료한 칸 / 전체 칸(설비 × 회차)
            const parentKind = r.expected === 0 ? "pending"
              : r.count >= r.expected ? "ok"
              : r.allDone ? "unmapped" : "short";
            const parentTip = parentKind === "unmapped"
              ? "설비 점검은 전부 끝났는데 엑셀이 아직 없습니다"
              : parentKind === "pending" ? "아직 생성 시점이 안 됐습니다(보통 월말)" : "";
            const parent = `
              <tr class="insp-row-parent" onclick="toggleInspDetail(${i})">
                <td>${esc(r.stype)}</td>
                <td><span class="insp-caret" id="insp-caret-${i}">▸</span>${esc(r.label)}</td>
                <td>${r.fidRows.length}</td>
                <td title="${r.stype} 회차 ${r.totalPeriods}건 중 지금까지 ${r.expected}건이 끝났습니다">${r.count}</td>
                <td title="설비 ${r.fidRows.length}개 × 회차 ${r.totalPeriods}건 중 ${r.slotsDone}칸 완료">${r.slotsDone}</td>
                <td class="insp-last">${r.lastAny ? esc(inspShortDt(r.lastAny.dt)) : ""}</td>
                <td>${inspBadge(parentKind, parentTip)}</td>
              </tr>`;
            const children = r.fidRows.map(f => {
              // 설비 행 = 점검 축. 기간이 안 끝났어도 **했으면 완료**다.
              const total = f.done + f.donePending;
              const kind = r.expected === 0
                ? (f.donePending > 0 ? "done" : "waiting")          // 끝난 회차가 없는 달
                : (f.done >= r.expected ? "done" : "missing");      // 끝난 회차 기준으로 판정
              const tip = kind === "missing" && f.donePending
                ? "끝난 회차 중 빠진 것이 있습니다(이번 회차는 이미 점검했습니다)"
                : kind === "waiting" ? "아직 기간이 안 끝났습니다 — 늦은 것이 아닙니다" : "";
              return `
              <tr class="insp-row-child" data-parent="${i}">
                <td></td>
                <td class="insp-fid-cell">${esc(f.fid)}${f.name ? `<span class="insp-fid-name">(${esc(f.name)})</span>` : ""}</td>
                <td></td>
                <td></td>
                <td title="${r.stype} 회차 ${r.totalPeriods}건 중 ${total}건 점검">${total}</td>
                <td class="insp-last">${f.last ? `${esc(inspShortDt(f.last.dt))}${f.last.w ? ` <span class="insp-fid-name">${esc(f.last.w)}</span>` : ""}` : "—"}</td>
                <td>${inspBadge(kind, tip)}${f.partial ? `<span class="insp-partial" title="로그는 있지만 필요한 시간대가 다 차지 않은 회차">△부분 ${f.partial}</span>` : ""}</td>
              </tr>`;
            }).join("");
            return parent + children;
          }).join("")}
        </tbody>
      </table>
      </div>`;
    card.style.display = "block";
    tableEl.innerHTML = html;
  } catch (e) {
    console.error("점검표 현황 조회 오류:", e);
    setInspReportMsg("조회 중 오류가 발생했습니다.", "error");
  } finally {
    btn.disabled = false;
  }
}

// ──────────────────────────────────────────────
// 보고서 탭 — 이벤트 엑셀 매핑(Callable: generateEventReport) / 다운로드(Callable: listEventReportFiles)
// 실제 xlsx 생성(사진 삽입 등)은 서버(Cloud Functions)에서만 하고, 프런트는 트리거+목록 표시만 담당
// ──────────────────────────────────────────────
function reportFilters() {
  return {
    center: document.getElementById("filter-center-report").value || "",
    status: document.getElementById("filter-status-report").value || "",
    start:  document.getElementById("filter-start-report").value || "",
    end:    document.getElementById("filter-end-report").value || "",
  };
}

function isOver1Year(start, end) {
  if (!start || !end) return false;
  return (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24) > 366;
}

function setReportMsg(text, type) {
  const el = document.getElementById("report-status-msg");
  el.textContent = text || "";
  el.className = "report-status-msg" + (type ? ` ${type}` : "");
}

async function mapEventReport() {
  const { center, status, start, end } = reportFilters();
  const btn = document.getElementById("report-map-btn");

  // [2026-08-05] 센터 필수. 예전엔 Master가 미선택이면 서버가 **전 센터를 순회하며**
  //   센터마다 보고서를 만들었다(사진 삽입까지 하는 무거운 작업이라 센터가 늘면 위험).
  if (!center) { setReportMsg("센터를 선택하세요.", "error"); return; }
  if (!start || !end) { setReportMsg("시작일과 종료일을 선택하세요.", "error"); return; }
  if (isOver1Year(start, end)) { setReportMsg("조회 기간은 최대 1년까지 가능합니다.", "error"); return; }

  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 매핑 중...`;
  setReportMsg("");
  try {
    const call = functions.httpsCallable("generateEventReport");
    const res  = await call({ center, status, start, end });
    const results = res.data.results || [];
    const done    = results.filter(r => r.fileName);
    const skipped = results.filter(r => r.skipped);
    const failed  = results.filter(r => r.error);

    let text = "";
    if (done.length)    text += `✅ ${done.length}개 센터 매핑 완료. `;
    if (skipped.length) text += `⏭ ${skipped.length}개 센터는 해당 기간에 이벤트 없음. `;
    if (failed.length)  text += `⚠️ ${failed.length}개 센터 실패.`;
    setReportMsg(text || "매핑이 완료되었습니다.", failed.length ? "error" : "success");

    // 매핑 직후 방금 만든 파일이 바로 보이게 목록도 갱신
    if (done.length) openReportFileList();
  } catch (e) {
    console.error("이벤트 보고서 매핑 오류:", e);
    setReportMsg((e.message || "").replace(/^[a-z-]+:\s*/i, "") || "매핑 중 오류가 발생했습니다.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-gears"></i> 매핑`;
  }
}

async function openReportFileList() {
  const center = document.getElementById("filter-center-report").value ||
    (currentUser.center_name !== "Master" ? currentUser.center_name : "");
  const card = document.getElementById("report-file-list-card");
  const listEl = document.getElementById("report-file-list");

  if (!center) {
    setReportMsg("파일 목록을 보려면 센터를 선택하세요.", "error");
    return;
  }
  card.style.display = "block";
  listEl.innerHTML = `<div class="report-file-loading">불러오는 중...</div>`;
  try {
    const call = functions.httpsCallable("listEventReportFiles");
    const res  = await call({ center });
    const files = res.data.files || [];
    if (files.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>생성된 파일이 없습니다.</p></div>`;
      return;
    }
    listEl.innerHTML = files.map(f => `
      <div class="report-file-item">
        <div class="excel-icon"><i class="fa-solid fa-file-excel" style="color:#217346;font-size:1.6rem;"></i></div>
        <div class="report-file-info">
          <div class="report-file-name">${esc(f.name)}</div>
          <div class="report-file-meta">${esc(fmtFileDate(f.updated))} · ${esc(fmtFileSize(f.size))}</div>
        </div>
        <a class="dl-btn" href="${esc(f.url)}" target="_blank" rel="noopener" download>⬇ 다운로드</a>
      </div>`).join("");
  } catch (e) {
    console.error("보고서 파일 목록 조회 오류:", e);
    listEl.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>파일 목록을 불러오지 못했습니다.</p></div>`;
  }
}

function fmtFileDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtFileSize(bytes) {
  if (!bytes) return "0KB";
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(0)}KB` : `${(kb / 1024).toFixed(1)}MB`;
}

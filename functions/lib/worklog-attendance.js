// lib/worklog-attendance.js
// 출근부 템플릿을 읽어 근무일지 기본값을 자동으로 채워주는 스케줄
const { onSchedule } = require("firebase-functions/v2/scheduler");
const ExcelJS = require("exceljs");
const { admin, db, bucket } = require("./firebase");
const {
  ATTENDANCE_CODE_MAP,
  ATTENDANCE_HEADER_MAX_ROW,
  ATTENDANCE_MAX_DATA_ROWS,
  ATTENDANCE_MAX_COL,
} = require("../config/constants");
const { getKstDateParts } = require("./dateUtils");

// Storage에서 센터별 출근부 템플릿(templates/{center}/work_sheet.xlsx)을 불러와
// 대상 월의 시트를 반환. 없으면 null.
async function loadAttendanceSheet(center, month) {
  const templatePath = `templates/${center}/work_sheet.xlsx`;
  const templateFile = bucket.file(templatePath);
  const [exists] = await templateFile.exists();
  if (!exists) {
    console.warn(`[출근부 매핑] 템플릿 없음: ${templatePath}`);
    return null;
  }
  const buf = await templateFile.download();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf[0]);

  // 시트명이 "7월"/"07월" 등으로 들쭉날쭉할 수 있어 이름으로 먼저 찾고, 실패하면 유일한 시트를 사용
  let ws = wb.worksheets.find(s => s.name.replace(/\s/g, "") === `${month}월`)
    || wb.worksheets.find(s => s.name.replace(/\s/g, "") === `${String(month).padStart(2, "0")}월`);
  if (!ws && wb.worksheets.length === 1) ws = wb.worksheets[0];
  if (!ws) {
    console.warn(`[출근부 매핑] "${month}월" 시트를 찾을 수 없음: ${templatePath} (실제 시트: ${wb.worksheets.map(s => s.name).join(", ")})`);
    return null;
  }
  return ws;
}

// "성명" 헤더 셀 위치를 찾음 — 열이 밀려도(예: D열→E열) 안전하도록 좌표를 하드코딩하지 않고
// 매번 텍스트로 탐색 (2026-07 실제로 열 위치가 템플릿마다 다른 것이 확인됨)
function findAttendanceNameHeader(ws) {
  for (let r = 1; r <= ATTENDANCE_HEADER_MAX_ROW; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= ATTENDANCE_MAX_COL; c++) {
      const raw = row.getCell(c).value;
      const v = String(raw ?? "").trim();
      if (v === "성명") return { row: r, col: c };
    }
  }
  return null;
}

// 헤더 행에서 목표 날짜(숫자)가 적힌 열을 찾음 (성명 열 오른쪽부터만 탐색 — 왼쪽의 "구분"
// 번호 열(1,2,3...)과 날짜 열(1,2,3...)이 값만으로는 구분 안 되므로 탐색 시작 위치로 방지)
function findAttendanceDateColumn(ws, headerRow, nameCol, targetDay) {
  const row = ws.getRow(headerRow);
  for (let c = nameCol + 1; c <= ATTENDANCE_MAX_COL; c++) {
    const v = row.getCell(c).value;
    const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
    if (!Number.isNaN(n) && n === targetDay) return c;
  }
  return null;
}

// 출근부 시트 + 목표 날짜 → 근무일지 필드 payload로 집계 (VBA 매크로 집계 로직 이식)
function aggregateAttendance(ws, targetDay) {
  const header = findAttendanceNameHeader(ws);
  if (!header) { console.warn('[출근부 매핑] "성명" 헤더를 찾지 못함'); return null; }
  const dateCol = findAttendanceDateColumn(ws, header.row, header.col, targetDay);
  if (!dateCol) { console.warn(`[출근부 매핑] ${targetDay}일 열을 찾지 못함`); return null; }

  const counts = { day: 0, night: 0, off: 0, rest: 0, edu: 0, sick: 0, annual: 0, compoff: 0 };
  const names  = { day: [], night: [], offList: [] }; // offList: 비/휴/교/연/휴가/대휴/오/병 통합 ("이름(코드)")

  const dataStartRow = header.row + 2; // 헤더 다음 줄(요일 행)은 건너뜀
  for (let r = dataStartRow; r <= dataStartRow + ATTENDANCE_MAX_DATA_ROWS; r++) {
    const row = ws.getRow(r);

    // 입사자/퇴사자 섹션 등 직원 명단 이후 구간을 만나면 종료 (공백 섞인 "입 사 자"도 대비)
    const rowText = [1, 2, 3, 4, 5, 6].map(c => String(row.getCell(c).value ?? "")).join("").replace(/\s/g, "");
    if (rowText.includes("입사자") || rowText.includes("퇴사자")) break;

    const name = String(row.getCell(header.col).value ?? "").trim();
    if (!name) continue;

    const code = String(row.getCell(dateCol).value ?? "").trim();
    if (!code) continue;

    const category = ATTENDANCE_CODE_MAP[code];
    if (!category) continue; // 매핑 안 된 코드는 무시 (알 수 없는 표기)

    if (category === "day")        { counts.day++; names.day.push(name); }
    else if (category === "night") { counts.night++; names.night.push(name); }
    else {
      counts[category] = (counts[category] || 0) + 1;
      names.offList.push(`${name}(${code})`);
    }
  }

  return {
    cnt_attend: counts.day + counts.night, // VBA 원본과 동일하게 출근자만 자동 계산 (총원은 수기 유지)
    cnt_day: counts.day, cnt_night: counts.night,
    cnt_off: counts.off, cnt_rest: counts.rest,
    cnt_annual: counts.annual, cnt_compoff: counts.compoff,
    cnt_edu: counts.edu, cnt_sick: counts.sick,
    names_day: names.day.join(", "),
    names_night: names.night.join(", "),
    names_off: names.offList.join(", "),
  };
}

// ==============================================================================
// [스케줄 3] 출근부 → 근무일지 자동 채움 (매일 09:00 Asia/Seoul)
// 오늘 근무일 문서가 아직 없을 때만 동작 — 이미 누군가 손으로 작성을 시작한 문서는
// 절대 덮어쓰지 않음 (단일값 필드 저장 원칙과 동일한 이유)
// ==============================================================================
exports.workLogDailyInit = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Seoul", timeoutSeconds: 300, memory: "512MiB" },
  async () => {
    const today = getKstDateParts(new Date());
    const workday = `${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;

    let centers = [];
    try {
      const doc = await db.collection("settings").doc("all_centers").get();
      centers = doc.exists ? (doc.data().centers || []) : [];
    } catch (e) {
      console.error("[출근부 매핑] 센터 목록 조회 실패:", e);
      return null;
    }

    console.log(`[출근부 매핑] 대상 근무일: ${workday}, 센터 ${centers.length}곳`);

    for (const center of centers) {
      try {
        const docId = `${center}_${workday}`;
        const docRef = db.collection("work_logs").doc(docId);
        const existing = await docRef.get();
        if (existing.exists) {
          console.log(`[출근부 매핑] ${docId} 이미 존재(수기 작성 중으로 간주) — 스킵`);
          continue;
        }

        const ws = await loadAttendanceSheet(center, today.m);
        if (!ws) { console.warn(`[출근부 매핑] ${center} 출근부 템플릿 없어 스킵`); continue; }

        const payload = aggregateAttendance(ws, today.d);
        if (!payload) { console.warn(`[출근부 매핑] ${center} 집계 실패 — 스킵`); continue; }

        await docRef.set({
          ...payload,
          center_name: center,
          workday,
          date_input: workday,
          source: "attendance_auto",
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        console.log(`[출근부 매핑] ${docId} 자동 채움 완료`);
      } catch (e) {
        console.error(`[출근부 매핑] ${center} 처리 실패 (다른 센터는 계속 진행):`, e);
      }
    }
    return null;
  }
);

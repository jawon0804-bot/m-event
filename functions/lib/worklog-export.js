// lib/worklog-export.js
// 근무일지(work_logs) → 센터별 월별 엑셀 파일로 매일 내보내기
const { onSchedule } = require("firebase-functions/v2/scheduler");
const ExcelJS = require("exceljs");
const { db, bucket } = require("./firebase");
const { WORKLOG_TEMPLATE_SHEET, WORKLOG_LAYOUT } = require("../config/constants");
const { getKstDateParts } = require("./dateUtils");

// 셀(또는 병합 범위)에 "값만" 씀 — 라벨/서식/병합/테두리는 템플릿이 이미 갖고 있으므로 건드리지 않음
function wlSetValue(ws, range, value) {
  if (value === undefined || value === "") return;
  const first = range.split(":")[0];
  const cell = ws.getCell(first);
  cell.value = value;
  return cell;
}

// work_logs 데이터를 (템플릿에서 복제된) 워크시트의 정해진 좌표에만 값으로 채워 넣음
// ※ 라벨 텍스트/병합/테두리는 templates/{center}/work_log.xlsx 의 "양식" 시트를 그대로 복제해서
//   이미 존재하므로 여기서는 절대 새로 만들지 않음 (cloneTemplateSheet 참고)
function fillWorkLogValues(ws, payload, center) {
  const L = WORKLOG_LAYOUT;
  const base = payload.base || {};

  // 제목만 센터명이 들어가므로 템플릿 값을 덮어씀 (템플릿 자체엔 플레이스홀더/공백으로 둬도 됨)
  wlSetValue(ws, L.title, `${center} 시설 업무일지`);

  wlSetValue(ws, L.sign.staff, base.sig_staff || "");
  wlSetValue(ws, L.sign.manager, base.sig_manager || "");
  wlSetValue(ws, L.sign.teamlead, base.sig_teamlead || "");

  const dateCell = wlSetValue(ws, L.date, base.date_input || "");
  if (dateCell && base.date_input) dateCell.numFmt = "yyyy-mm-dd";
  wlSetValue(ws, L.weather, base.weather_input || "");

  wlSetValue(ws, L.personnel.total, base.cnt_total || "");
  wlSetValue(ws, L.personnel.attend, base.cnt_attend || "");
  wlSetValue(ws, L.personnel.day, base.cnt_day || "");
  wlSetValue(ws, L.personnel.night, base.cnt_night || "");
  wlSetValue(ws, L.personnel.off, base.cnt_off || "");
  wlSetValue(ws, L.personnel.rest, base.cnt_rest || "");
  wlSetValue(ws, L.personnel.annual, base.cnt_annual || "");
  wlSetValue(ws, L.personnel.compoff, base.cnt_compoff || "");
  wlSetValue(ws, L.personnel.edu, base.cnt_edu || "");
  wlSetValue(ws, L.personnel.sick, base.cnt_sick || "");
  wlSetValue(ws, L.personnel.namesDay, base.names_day || "");
  wlSetValue(ws, L.personnel.namesNight, base.names_night || "");
  wlSetValue(ws, L.personnel.namesOff, base.names_off || "");

  wlSetValue(ws, L.utilWater.name, base.util_water_name || "");
  wlSetValue(ws, L.utilWater.prev, base.util_water_prev || "");
  wlSetValue(ws, L.utilWater.today, base.util_water_today || "");
  wlSetValue(ws, L.utilWater.usage, base.util_water_usage || "");
  wlSetValue(ws, L.utilWater.cum, base.util_water_cum || "");
  wlSetValue(ws, L.utilWater.month, base.util_water_month || "");
  wlSetValue(ws, L.utilKw.usage, base.util_kw_usage || "");
  wlSetValue(ws, L.utilKw.cum, base.util_kw_cum || "");
  wlSetValue(ws, L.utilKw.month, base.util_kw_month || "");

  L.legalRows.forEach((r, i) => {
    const entry = (payload.legal || [])[i];
    if (!entry) return;
    wlSetValue(ws, r.sched, entry.sched || "");
    wlSetValue(ws, r.company, entry.company || "");
    wlSetValue(ws, r.contact, entry.contact || "");
    wlSetValue(ws, r.content, entry.content || "");
  });

  L.dayRows.forEach((r, i) => {
    wlSetValue(ws, r.work, (payload.dayWork || [])[i]?.content || "");
    wlSetValue(ws, r.check, (payload.dayCheck || [])[i]?.content || "");
  });

  L.nightRows.forEach((r, i) => {
    wlSetValue(ws, r.work, (payload.nightWork || [])[i]?.content || "");
    wlSetValue(ws, r.note, (payload.nightNote || [])[i]?.content || "");
  });

  L.materialRows.forEach((r, i) => {
    const entry = (payload.material || [])[i];
    if (!entry) return;
    wlSetValue(ws, r.workno, entry.workno || "");
    wlSetValue(ws, r.partno, entry.partno || "");
    wlSetValue(ws, r.qty, entry.qty || "");
    wlSetValue(ws, r.unit, entry.unit || "");
    wlSetValue(ws, r.usage, entry.usage || "");
    wlSetValue(ws, r.date, entry.date || "");
    wlSetValue(ws, r.stock, entry.stock || "");
  });
}

// ==============================================================================
// [근무일지 → 엑셀] 템플릿 로드 & 복제
// ==============================================================================
// Storage에서 센터별 원본 양식 템플릿(templates/{center}/work_log.xlsx)을 불러와
// "양식" 시트(ExcelJS Worksheet 객체)를 반환. 없으면 null.
async function loadWorkLogTemplate(center) {
  const templatePath = `templates/${center}/work_log.xlsx`;
  const templateFile = bucket.file(templatePath);
  const [exists] = await templateFile.exists();
  if (!exists) {
    console.warn(`[근무일지 내보내기] 템플릿 없음: ${templatePath}`);
    return null;
  }
  const buf = await templateFile.download();
  const tplWorkbook = new ExcelJS.Workbook();
  await tplWorkbook.xlsx.load(buf[0]);
  const tplSheet = tplWorkbook.getWorksheet(WORKLOG_TEMPLATE_SHEET);
  if (!tplSheet) {
    console.warn(`[근무일지 내보내기] 템플릿에 "${WORKLOG_TEMPLATE_SHEET}" 시트가 없음: ${templatePath}`);
    return null;
  }
  return tplSheet;
}

// 템플릿 시트를 대상 워크북에 새 시트(sheetName)로 복제
// (열 너비/행 높이/병합 범위/셀 값·서식/인쇄 설정까지 그대로 복사 — ExcelJS는 워크북 간
//  시트 이동을 직접 지원하지 않아 셀 단위로 복사함)
function cloneTemplateSheet(targetWorkbook, tplSheet, sheetName) {
  const ws = targetWorkbook.addWorksheet(sheetName, { views: tplSheet.views });

  ws.columns = tplSheet.columns.map(col => ({ width: col?.width }));

  // 인쇄영역/용지방향/배율/여백/맞쪽인쇄 등 페이지 설정 복제
  // (row/column 구조를 그대로 복제하므로 printArea 좌표("A1:N54" 등)도 그대로 유효함)
  if (tplSheet.pageSetup) {
    ws.pageSetup = { ...tplSheet.pageSetup };
  }
  if (tplSheet.headerFooter) {
    ws.headerFooter = { ...tplSheet.headerFooter };
  }

  (tplSheet.model.merges || []).forEach(range => {
    try { ws.mergeCells(range); } catch (e) { console.warn(`[근무일지 내보내기] 병합 복제 실패(${range}):`, e.message); }
  });

  tplSheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const newRow = ws.getRow(rowNumber);
    if (row.height) newRow.height = row.height;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const newCell = newRow.getCell(colNumber);
      newCell.value = cell.value;
      if (cell.style) newCell.style = { ...cell.style };
    });
    newRow.commit();
  });

  return ws;
}

// ==============================================================================
// [스케줄 2] 근무일지 → 엑셀 변환 (매일 09:00 Asia/Seoul)
// 이 스케줄러가 도는 정각(09:00)에 "방금 막 끝난 근무일"은 항상 어제 날짜
// (근무일 정의: 어제 09:00 ~ 오늘 09:00 = "어제" 근무일)
// ==============================================================================
exports.workLogDailyExport = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Seoul", timeoutSeconds: 300, memory: "512MiB" },
  async () => {
    const today = getKstDateParts(new Date());
    // KST 달력 기준 "어제" — UTC 연산으로 월/년 경계 자동 처리
    const y = new Date(Date.UTC(today.y, today.m - 1, today.d - 1));
    const wy = y.getUTCFullYear(), wm = y.getUTCMonth() + 1, wd = y.getUTCDate();
    const workday = `${wy}-${String(wm).padStart(2, "0")}-${String(wd).padStart(2, "0")}`;

    let centers = [];
    try {
      const doc = await db.collection("settings").doc("all_centers").get();
      centers = doc.exists ? (doc.data().centers || []) : [];
    } catch (e) {
      console.error("[근무일지 내보내기] 센터 목록 조회 실패:", e);
      return null;
    }

    console.log(`[근무일지 내보내기] 대상 근무일: ${workday}, 센터 ${centers.length}곳`);

    for (const center of centers) {
      try {
        const docId = `${center}_${workday}`;
        const baseSnap = await db.collection("work_logs").doc(docId).get();
        if (!baseSnap.exists) {
          console.log(`[근무일지 내보내기] ${docId} 문서 없음(작성 내역 없음), 스킵`);
          continue;
        }

        const payload = { base: baseSnap.data() };
        for (const sub of ["dayWork", "dayCheck", "nightWork", "nightNote", "legal", "material"]) {
          const subSnap = await db.collection("work_logs").doc(docId).collection(sub)
            .orderBy("created_at", "asc").get();
          payload[sub] = subSnap.docs.map(d => d.data());
        }

        // 센터별 원본 양식 템플릿 로드 (없으면 이 센터는 스킵 — 다른 센터는 계속 진행)
        const tplSheet = await loadWorkLogTemplate(center);
        if (!tplSheet) {
          console.error(`[근무일지 내보내기] ${center} 템플릿 없어 스킵 (templates/${center}/work_log.xlsx 확인 필요)`);
          continue;
        }

        const fileName = `${wy}년_${wm}월_점검표.xlsx`;
        const filePath = `work_log/${center}/${fileName}`;
        const file = bucket.file(filePath);

        const workbook = new ExcelJS.Workbook();
        const [exists] = await file.exists();
        if (exists) {
          const buf = await file.download();
          await workbook.xlsx.load(buf[0]);
        }

        const sheetName = `${wd}일`;
        const existingSheet = workbook.getWorksheet(sheetName);
        if (existingSheet) workbook.removeWorksheet(existingSheet.id); // 같은 날짜 재실행 시 덮어쓰기

        const ws = cloneTemplateSheet(workbook, tplSheet, sheetName); // 템플릿을 새 날짜 시트로 복제
        fillWorkLogValues(ws, payload, center);                       // 정해진 좌표에 값만 채움

        const outBuf = await workbook.xlsx.writeBuffer();
        await file.save(outBuf, {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        console.log(`[근무일지 내보내기] ${filePath} / 시트 "${sheetName}" 완료`);
      } catch (e) {
        console.error(`[근무일지 내보내기] ${center} 처리 실패 (다른 센터는 계속 진행):`, e);
      }
    }
    return null;
  }
);

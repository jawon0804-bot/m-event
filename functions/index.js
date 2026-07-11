/**
 * Firebase Functions (2nd Gen) - M-Event 이슈 트래커 + 근무일지
 *
 * [트리거/스케줄]
 *   onInspectionLog        : inspection_logs 문서 생성/수정 시 memo 필드 감지 → events 생성 + 메일
 *   onIssueUpdate          : events 문서 status 변경 시 → 조치/완료 메일
 *   issueReminderScheduler : 매일 09:00 (Asia/Seoul) — 3일 이상 미조치 이벤트 재알림
 *   workLogDailyExport     : 매일 09:00 (Asia/Seoul) — 방금 끝난 근무일(어제 09:00~오늘 09:00)의
 *                            work_logs 데이터를, Storage의 센터별 원본 양식
 *                            (templates/{center}/work_log.xlsx, 시트 "양식")을 복제해
 *                            센터별 월별 엑셀 파일(work_log/{center}/...)에 날짜 시트로 반영
 *
 * [배포]
 *   firebase deploy --only functions:onInspectionLog,functions:onIssueUpdate,functions:issueReminderScheduler,functions:workLogDailyExport
 *   (firebase deploy --only functions 전체 배포 금지 — 같은 프로젝트의 별도 모니터링 함수와
 *    codebase가 분리되어 있어 구조적으로는 안전하지만, 안전을 위해 항상 함수명 지정)
 *
 * [환경변수/시크릿]
 *   GMAIL_USER, GMAIL_PASS — Secret Manager(defineSecret)로만 관리. 평문 .env 파일 절대 병행 금지.
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const ExcelJS = require("exceljs");

admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

setGlobalOptions({ region: "asia-northeast3" });

const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_PASS = defineSecret("GMAIL_PASS");

// ==============================================================================
// [유틸] Gmail 인증 정보 (Secret Manager)
// ==============================================================================
function getGmailAuth() {
  return { user: GMAIL_USER.value(), pass: GMAIL_PASS.value() };
}

const getTransporter = () => nodemailer.createTransport({ service: "gmail", auth: getGmailAuth() });

// ==============================================================================
// [유틸] HTML 이스케이프 (이메일 본문 인젝션 방지)
// ==============================================================================
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function nl2br(s) { return escHtml(s).replace(/\n/g, "<br>"); }

// ==============================================================================
// [유틸] 센터 관리자 이메일 목록 조회
// ==============================================================================
async function getAdminEmails(center_name) {
  try {
    const snap = await db.collection("UserDB")
      .where("center_name", "==", center_name)
      .where("active", "==", true)
      .get();
    return snap.docs.map(d => d.data().email).filter(Boolean);
  } catch (e) {
    console.error("관리자 이메일 조회 실패:", e);
    return [];
  }
}

// ==============================================================================
// [유틸] 이메일 발송 — 실패해도 throw하지 않고 boolean 반환 (트리거 흐름 유지)
// ==============================================================================
async function sendMail(to, subject, html) {
  if (!to || to.length === 0) { console.warn("수신자 없음, 메일 발송 스킵"); return false; }
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"M-Event 알림" <${getGmailAuth().user}>`,
      to: Array.isArray(to) ? to.join(", ") : to,
      subject, html,
    });
    console.log("메일 발송 완료:", subject, "→", to);
    return true;
  } catch (e) {
    console.error("메일 발송 실패:", e);
    return false;
  }
}

function makeEmailHtml({ title, center_name, facility_id, fid_name, worker, workerLabel = "점검자", datetime, memo, actionUrl }) {
  return `
  <div style="font-family:Apple SD Gothic Neo,맑은 고딕,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    <div style="background:#1e3a5f;padding:20px 24px">
      <h2 style="color:#fff;margin:0;font-size:18px">📝 M-Event 알림</h2>
    </div>
    <div style="padding:24px">
      <h3 style="margin:0 0 16px;color:#111;font-size:16px">${escHtml(title)}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:8px 0;color:#6b7280;width:80px">센터</td><td style="padding:8px 0;color:#111;font-weight:600">${escHtml(center_name)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">설비</td><td style="padding:8px 0;color:#111">${escHtml(fid_name || facility_id)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">${escHtml(workerLabel)}</td><td style="padding:8px 0;color:#111">${escHtml(worker)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">일시</td><td style="padding:8px 0;color:#111">${escHtml(datetime)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">내용</td>
            <td style="padding:8px 0;color:#dc2626;font-weight:600">${nl2br(memo)}</td></tr>
      </table>
      ${actionUrl ? `
      <div style="margin-top:24px;text-align:center">
        <a href="${escHtml(actionUrl)}" style="display:inline-block;background:#1e3a5f;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">
          이벤트 트래커에서 확인하기 →
        </a>
      </div>` : ""}
    </div>
    <div style="background:#f9fafb;padding:12px 24px;font-size:12px;color:#9ca3af;text-align:center">
      M-Event 자동 발송 메일입니다.
    </div>
  </div>`;
}

// ==============================================================================
// [트리거 1] inspection_logs 문서 생성/수정 감지 (2nd Gen: onDocumentWritten)
// ==============================================================================
exports.onInspectionLog = onDocumentWritten(
  { document: "inspection_logs/{docId}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async (event) => {
    const after = event.data.after.exists ? event.data.after.data() : null;
    const before = event.data.before.exists ? event.data.before.data() : null;
    if (!after) return null;

    const memo = (after.memo || "").trim();
    if (!memo) return null;
    const prevMemo = (before?.memo || "").trim();
    if (memo === prevMemo) return null;

    const center_name = after.center_name || "";
    const facility_id = after.facility_id || "";
    const worker      = after.worker || "";
    const datetime    = after.datetime || "";
    const photos      = after.photos || "";
    const logDocId    = event.params.docId;

    let fid_name = facility_id;
    try {
      const firstFid = (facility_id || "").split(",")[0].trim();
      if (firstFid) {
        const facDoc = await db.collection("center_configs").doc(center_name)
          .collection("facilities").doc(firstFid).get();
        if (facDoc.exists) fid_name = facDoc.data().fid_name || facility_id;
      }
    } catch (e) { console.warn("fid_name 조회 실패:", e); }

    console.log(`[이슈 생성] ${center_name} / ${facility_id} / memo: ${memo}`);

    const eventRef = db.collection("events").doc(`log_${logDocId}`);
    const eventDoc = await eventRef.get();

    if (eventDoc.exists) {
      await eventRef.update({ memo, photos, updated_at: admin.firestore.FieldValue.serverTimestamp() });
      console.log("[이슈 업데이트] 기존 이슈 memo 수정:", eventRef.id);
      return null;
    }

    const legacy = await db.collection("events").where("source_log_id", "==", logDocId).limit(1).get();
    if (!legacy.empty) {
      await legacy.docs[0].ref.update({ memo, photos, updated_at: admin.firestore.FieldValue.serverTimestamp() });
      console.log("[이슈 업데이트] 레거시 이슈 memo 수정:", legacy.docs[0].id);
      return null;
    }

    await eventRef.set({
      center_name, facility_id, fid_name, worker, memo, datetime, photos,
      source_log_id: logDocId,
      status: "발생",
      history: [{ type: "발생", content: memo, by: worker, at: admin.firestore.Timestamp.now() }],
      last_notified_at: admin.firestore.Timestamp.now(),
      notified_count: 0,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
      completed_at: null,
    });
    console.log("[이슈 생성 완료]", eventRef.id);

    const adminEmails = await getAdminEmails(center_name);
    const eventUrl = `https://m-smart-0804.web.app/index.html?id=${eventRef.id}`;
    await sendMail(
      adminEmails,
      `[이벤트 발생] ${center_name} - ${facility_id} - ${memo}`,
      makeEmailHtml({ title: "🔴 새 이벤트가 등록되었습니다", center_name, facility_id, fid_name, worker, datetime, memo, actionUrl: eventUrl })
    );
    return null;
  }
);

// ==============================================================================
// [트리거 2] events 문서 status 변경 감지 (2nd Gen: onDocumentUpdated)
// ==============================================================================
exports.onIssueUpdate = onDocumentUpdated(
  { document: "events/{eventId}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return null;

    const center_name = after.center_name || "";
    const facility_id = after.facility_id || "";
    const memo     = after.memo || "";
    const datetime = after.datetime || "";
    const eventId  = event.params.eventId;
    const eventUrl = `https://m-smart-0804.web.app/index.html?id=${eventId}`;
    const adminEmails = await getAdminEmails(center_name);
    const lastHistory = (after.history || []).slice(-1)[0] || {};

    if (after.status === "조치중") {
      await sendMail(adminEmails, `[조치 진행] ${center_name} - ${facility_id} - ${memo}`,
        makeEmailHtml({ title: "🟡 이벤트 조치가 시작되었습니다", center_name, facility_id, worker: lastHistory.by || "", workerLabel: "작성자", datetime, memo: lastHistory.content || "", actionUrl: eventUrl }));
    } else if (after.status === "완료") {
      await sendMail(adminEmails, `[이벤트 완료] ${center_name} - ${facility_id} - ${memo}`,
        makeEmailHtml({ title: "🟢 이벤트가 완료 처리되었습니다", center_name, facility_id, worker: lastHistory.by || "", workerLabel: "작성자", datetime, memo: lastHistory.content || "", actionUrl: eventUrl }));
    }
    return null;
  }
);

// ==============================================================================
// [스케줄 1] 3일 경과 이슈 알림 (2nd Gen: onSchedule)
// ==============================================================================
exports.issueReminderScheduler = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Seoul", secrets: [GMAIL_USER, GMAIL_PASS] },
  async () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const threshold = admin.firestore.Timestamp.fromDate(threeDaysAgo);

    let snap;
    try {
      snap = await db.collection("events")
        .where("status", "in", ["발생", "조치중"])
        .where("last_notified_at", "<=", threshold)
        .get();
    } catch (e) {
      console.error("[3일 알림] 쿼리 실패 (복합 색인 확인 필요):", e);
      return null;
    }

    console.log(`[3일 알림] 대상 이슈: ${snap.size}건`);
    let sent = 0;

    for (const doc of snap.docs) {
      const issue = doc.data();
      const center_name = issue.center_name || "";
      const facility_id = issue.facility_id || "";
      const memo   = issue.memo || "";
      const status = issue.status || "";
      const count  = (issue.notified_count || 0) + 1;
      const eventUrl = `https://m-smart-0804.web.app/index.html?id=${doc.id}`;
      const adminEmails = await getAdminEmails(center_name);

      const ok = await sendMail(
        adminEmails,
        `[${count}차 미조치 알림] ${center_name} - ${facility_id} - ${memo}`,
        makeEmailHtml({
          title: `⚠️ 미처리 이벤트 ${count}차 알림 (현재 상태: ${status})`,
          center_name, facility_id, worker: issue.worker || "", datetime: issue.datetime || "",
          memo: `${memo}\n\n※ 이 이슈는 3일 이상 처리되지 않아 재알림이 발송됩니다.`,
          actionUrl: eventUrl,
        })
      );
      if (ok) {
        await doc.ref.update({ last_notified_at: admin.firestore.Timestamp.now(), notified_count: count });
        sent++;
      }
    }
    console.log(`[3일 알림] 완료: 대상 ${snap.size}건 중 ${sent}건 발송/갱신`);
    return null;
  }
);

// ==============================================================================
// [근무일지 → 엑셀] 좌표 정의
// 실제 라벨/서식/병합은 Storage 템플릿(templates/{center}/work_log.xlsx, 시트 "양식")에
// 들어있고, 여기 좌표는 "그 템플릿의 어느 셀에 어떤 값을 넣을지"만 정의함
// (2026-07-07 실측 기준. ⚠️ D28/D30은 원본에 병합이 빠져있던 부분을 다른 줄과 동일하게
// 병합 처리하기로 함 — 실수로 확인됨. 템플릿 자체를 수정하면 이 좌표도 함께 맞춰야 함.)
// 라벨/병합 구조를 바꾸려면 Storage의 템플릿 파일과 프런트엔드 wl-sheet 테이블 마크업,
// 그리고 이 좌표 상수까지 셋을 함께 수정해야 함.
// ==============================================================================
const WORKLOG_LAYOUT = {
  title: "B2:J3",
  sign: { staff: "L3:L4", manager: "M3:M4", teamlead: "N3:N4" },
  date: "B5:C5",
  weather: "E5", // 원본에 병합 없음 — 테두리도 없이 흘림 텍스트로 둠

  personnel: {
    total: "C7:D7", attend: "E7:F7",
    day: "G7", night: "H7", off: "I7", rest: "J7",
    annual: "K7", compoff: "L7", edu: "M7", sick: "N7",
    namesDay: "C9:F9", namesNight: "G9:J9", namesOff: "K9:N9",
  },

  utilWater: { name: "C14:E14", prev: "H14:I14", today: "J14:K14", usage: "L14", cum: "M14", month: "N14" },
  utilKw:    { usage: "L15", cum: "M15", month: "N15" },

  legalRows: [19, 20, 21, 22, 23].map(r => ({
    row: r, sched: `C${r}:D${r}`, company: `E${r}:F${r}`, contact: `G${r}:H${r}`, content: `I${r}:N${r}`,
  })),

  dayRows: Array.from({ length: 10 }, (_, i) => {
    const r = 26 + i;
    return { row: r, work: `D${r}:K${r}`, check: `L${r}:N${r}` };
  }),

  nightRows: Array.from({ length: 10 }, (_, i) => {
    const r = 38 + i;
    return { row: r, work: `D${r}:K${r}`, note: `L${r}:N${r}` };
  }),

  materialRows: [50, 51, 52, 53, 54].map(r => ({
    row: r, workno: `C${r}`, partno: `D${r}:G${r}`, qty: `H${r}`,
    unit: `I${r}`, usage: `J${r}:L${r}`, date: `M${r}`, stock: `N${r}`,
  })),
};

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
const WORKLOG_TEMPLATE_SHEET = "양식"; // 템플릿 파일(work_log.xlsx) 안의 기준 시트명

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

// KST 기준 연/월/일 파트 추출 (프런트엔드 wlGetWorkday와 동일 원리 — Intl 사용, 로캘 파싱 문제 없음)
function getKstDateParts(d) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { y: parseInt(parts.year, 10), m: parseInt(parts.month, 10), d: parseInt(parts.day, 10) };
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

// ==============================================================================
// [출근부 자동 매핑] 코드 → 근무일지 필드 집계 로직
// 기존에 실제 운영하던 VBA 매크로(근무일지_통합_관리_매크로)의 집계 규칙을 그대로 이식:
//   주 → 주간, 야 → 야간, 비 → 비번, 휴 → 휴무, 교 → 교육, 병 → 병가,
//   연/휴가 → 연차(합산), 대휴/오 → 대휴(합산)
// ※ VBA 원본도 총원(总人员)은 자동 계산하지 않았음 — 출근자(주간+야간)만 자동 계산하고
//   총원은 그대로 수기 입력 항목으로 남겨둠 (검증된 기존 운영 방식을 그대로 따름)
// ==============================================================================
const ATTENDANCE_CODE_MAP = {
  "주": "day", "야": "night", "비": "off", "휴": "rest", "교": "edu", "병": "sick",
  "연": "annual", "휴가": "annual", "대휴": "compoff", "오": "compoff",
};

const ATTENDANCE_HEADER_MAX_ROW = 10;   // "성명" 헤더를 찾을 최대 탐색 행
const ATTENDANCE_MAX_DATA_ROWS  = 60;   // 직원 데이터 탐색 최대 행 수 (입사자 섹션 만나면 조기 종료)
const ATTENDANCE_MAX_COL        = 60;   // 헤더 행에서 날짜를 찾을 최대 열 수

// Storage에서 센터별 출근부 템플릿(templates/{center}/work_seet.xlsx)을 불러와
// 대상 월의 시트를 반환. 없으면 null.
async function loadAttendanceSheet(center, month) {
  const templatePath = `templates/${center}/work_seet.xlsx`;
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

// ==============================================================================
// [로그인] loginWithCredentials — 이름+전화번호 로그인을 서버(Cloud Function)에서 처리
//
// 기존 문제: 프런트엔드가 UserDB를 직접 조회해서 로그인 판정을 하고 있었음.
//   → 클라이언트가 결과를 조작할 수 있고, 로그인 시도 자체가 서버를 거치지 않아
//     "누가/언제/어느 IP에서 시도했는지" 전혀 기록이 안 남는 문제가 있었음
//   → 특히 A센터 사용자가 B센터 관리자의 이름+전화번호를 알아내 로그인하는 것을
//     막을 수도, 추적할 수도 없었음 (2026-07 설계 논의로 확인됨)
//
// 이 함수가 하는 일:
//   1. 이름 기준으로 로그인 시도 잠금 여부 확인 (5회 실패 시 15분 잠금)
//   2. UserDB 대조 (서버에서 수행 — 클라이언트가 판정 결과를 조작 불가)
//   3. [향후 확장 지점] UserDB 문서에 password_hash가 있으면 비밀번호도 검증 (지금은 미구현)
//   4. 성공/실패 관계없이 login_attempts에 IP·기기정보·시도 이름/전화번호 기록
//   5. 성공 시 Firebase Custom Token 발급 → 프런트가 firebase.auth()로 진짜 로그인
//      (커스텀 클레임에 center_name/active를 심어서, Firestore 보안 규칙에서
//       request.auth.token.center_name 으로 실제 접근 제어에 쓸 수 있게 함 — 규칙은 별도 작업 필요)
// ==============================================================================
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;

// ==============================================================================
// [2026-07-11 추가] IP 단위 잠금 — 이름 단위 잠금만으로는, 공격자가 이름마다
// LOGIN_MAX_ATTEMPTS-1번씩만 시도하고 다음 이름으로 넘어가면 어느 이름도 잠기지
// 않은 채 사실상 무제한으로 전화번호를 대입할 수 있었음. 같은 IP에서 여러 이름을
// 대상으로 실패가 누적되면 IP 자체를 잠가서 이 우회를 막는다.
// 다만 회사/센터 공유 와이파이처럼 여러 정상 사용자가 같은 IP를 쓸 수 있으므로,
// 이름 단위보다 훨씬 여유 있게(20회) 잡아서 정상적인 오타 몇 번으로는 안 걸리게 함.
// (완전한 전역 잠금은 공격자가 일부러 트리거해서 전체 서비스 로그인을 막아버리는
//  DoS로 악용될 수 있어 넣지 않음 — IP 단위가 그 우회 경로를 막으면서도 그 위험은 없음)
// ==============================================================================
const IP_MAX_ATTEMPTS = 20;
const IP_LOCKOUT_MINUTES = 15;

// 로그인 시도 결과를 잠금 문서에 원자적으로 반영 (동시 요청 레이스 방지)
// maxAttempts/lockoutMinutes를 받아서 이름 단위/IP 단위 양쪽에 재사용
async function registerLoginResult(lockRef, success, maxAttempts = LOGIN_MAX_ATTEMPTS, lockoutMinutes = LOGIN_LOCKOUT_MINUTES) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    const data = snap.exists ? snap.data() : {};
    const now  = Date.now();

    if (success) {
      tx.set(lockRef, { failCount: 0, lockedUntil: null, updated_at: admin.firestore.Timestamp.now() }, { merge: true });
      return { justLocked: false, attemptsLeft: null };
    }

    const nextCount  = (data.failCount || 0) + 1;
    const justLocked = nextCount >= maxAttempts;

    tx.set(lockRef, {
      failCount: justLocked ? 0 : nextCount, // 잠금 걸리면 카운트 리셋 (해제 후 다시 처음부터)
      lockedUntil: justLocked
        ? admin.firestore.Timestamp.fromMillis(now + lockoutMinutes * 60 * 1000)
        : null,
      updated_at: admin.firestore.Timestamp.now(),
    }, { merge: true });

    return { justLocked, attemptsLeft: justLocked ? 0 : maxAttempts - nextCount };
  });
}

// IP를 Firestore 문서 ID로 쓸 수 있게 정리 (슬래시가 경로 구분자와 충돌하므로 치환)
function sanitizeIpForDocId(ip) {
  return String(ip || "").trim().replace(/\//g, "_");
}

// 로그인 시도 기록 보관 기간 (일). 실패한 시도에는 남의 전화번호 추측값이
// 그대로 남기 때문에 무기한 보관하지 않고 Firestore TTL로 자동 삭제한다.
const LOGIN_ATTEMPT_RETENTION_DAYS = 90;

// 로그인 시도 기록 (성공/실패/차단 관계없이 항상 남김) — 기록 실패가 로그인 자체를 막으면 안 되므로 별도 try/catch
async function logLoginAttempt({ name, phone, ip, userAgent, success, blocked, matchedCenter, app }) {
  try {
    await db.collection("login_attempts").add({
      input_name: name,
      input_phone: phone,      // 실제 입력된 번호 그대로 기록 (본인 것인지 도용인지는 사후 대조용)
      matched_center: matchedCenter,
      app,                     // 어떤 앱(M-Event/M-SMART 등)에서 시도했는지
      success, blocked,
      ip, user_agent: userAgent,
      at: admin.firestore.FieldValue.serverTimestamp(),
      // [2026-07-11 추가] Firestore TTL 정책 대상 필드 — expireAt이 지나면
      // Firestore가 자동으로 문서를 삭제한다 (별도 삭제 배치 불필요).
      // 정책 자체는 `gcloud firestore fields ttls update`로 등록해야 동작함.
      expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + LOGIN_ATTEMPT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch (e) {
    console.error("[로그인] 시도 기록 실패:", e);
  }
}

// ==============================================================================
// [다중 앱 지원] 같은 UserDB/로그인 시스템을 M-Event 외 다른 앱(예: M-SMART)도 공유해서 씀.
// UserDB 문서에 allowed_apps: string[] 필드를 선택적으로 둘 수 있음:
//   - 필드가 아예 없으면(기존 사용자 전부 해당) → 모든 앱에서 로그인 허용 (하위호환, 기본 동작 안 바뀜)
//   - ["m-event"] 처럼 지정하면 → 그 배열에 있는 앱에서만 로그인 허용
// 호출하는 쪽(M-Event, M-SMART 등)은 loginWithCredentials({name, phone, app: "자기앱ID"})
// 형태로 자신의 app ID를 실어서 호출하면 됨. Callable Function이라 같은 Firebase 프로젝트
// 안이면 어느 Hosting 사이트/도메인에서 호출해도 별도 CORS 설정 없이 그대로 동작함.
// ⚠️ 단, Firebase Auth 로그인 세션(auth.onAuthStateChanged)은 브라우저 origin(도메인)
//   단위로 저장되므로, M-Event와 M-SMART가 서로 다른 도메인이면 한쪽 로그인이 다른 쪽에
//   자동으로 이어지진 않음 — 앱마다 이 함수를 각자 호출해서 각자 로그인해야 함
//   (완전 자동 SSO를 원하면 별도의 리다이렉트 기반 연동이 추가로 필요함).
// ==============================================================================
function isAppAllowed(userData, appId) {
  const allowed = userData.allowed_apps;
  if (!Array.isArray(allowed)) return true; // 필드 없으면 전체 허용 (기존 사용자 호환)
  return allowed.includes(appId);
}

exports.loginWithCredentials = onCall(async (request) => {
  const { name, phone, app /*, password (향후 확장) */ } = request.data || {};
  const rawRequest = request.rawRequest;
  const ip = (rawRequest?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || rawRequest?.ip || "";
  const userAgent = rawRequest?.headers?.["user-agent"] || "";

  const cleanName  = String(name || "").trim();
  const cleanPhone = String(phone || "").replace(/[^0-9]/g, "");
  const appId      = String(app || "m-event").trim(); // 안 넘기면 기존 M-Event 호출부와 호환되게 기본값 사용
  if (!cleanName || !cleanPhone) {
    throw new HttpsError("invalid-argument", "이름과 전화번호를 입력하세요.");
  }

  // 1) 잠금 여부 먼저 확인 — UserDB 조회 전에 차단해서 무차별 대입 비용을 낮춤
  //    (이름 단위 잠금은 어느 앱으로 시도하든 같은 사람을 노린 시도이므로 합산)
  const lockRef = db.collection("login_lockouts").doc(cleanName);
  const preCheck = await lockRef.get();
  if (preCheck.exists) {
    const d = preCheck.data();
    if (d.lockedUntil && d.lockedUntil.toMillis() > Date.now()) {
      await logLoginAttempt({ name: cleanName, phone: cleanPhone, ip, userAgent, success: false, blocked: true, matchedCenter: null, app: appId });
      const remainMin = Math.ceil((d.lockedUntil.toMillis() - Date.now()) / 60000);
      throw new HttpsError("resource-exhausted", `로그인 시도가 너무 많습니다. ${remainMin}분 후 다시 시도하세요.`);
    }
  }

  // 1-2) [2026-07-11 추가] IP 단위 잠금도 확인 — 이름을 바꿔가며 시도해서 이름 단위
  //      잠금을 우회하는 공격을 막기 위함 (위 IP_MAX_ATTEMPTS 주석 참고)
  const ipDocId = sanitizeIpForDocId(ip);
  const ipLockRef = ipDocId ? db.collection("login_lockouts_ip").doc(ipDocId) : null;
  if (ipLockRef) {
    const ipPreCheck = await ipLockRef.get();
    if (ipPreCheck.exists) {
      const d = ipPreCheck.data();
      if (d.lockedUntil && d.lockedUntil.toMillis() > Date.now()) {
        await logLoginAttempt({ name: cleanName, phone: cleanPhone, ip, userAgent, success: false, blocked: true, matchedCenter: null, app: appId });
        const remainMin = Math.ceil((d.lockedUntil.toMillis() - Date.now()) / 60000);
        throw new HttpsError("resource-exhausted", `이 네트워크에서 로그인 시도가 너무 많습니다. ${remainMin}분 후 다시 시도하세요.`);
      }
    }
  }

  // 2) UserDB 대조 (서버에서 수행)
  let matched = null;
  try {
    const snap = await db.collection("UserDB").where("name", "==", cleanName).limit(5).get();
    matched = snap.docs.find(d => (d.data().phone || "").replace(/[^0-9]/g, "") === cleanPhone) || null;
  } catch (e) {
    console.error("[로그인] UserDB 조회 실패:", e);
    throw new HttpsError("internal", "로그인 중 오류가 발생했습니다.");
  }

  // 이름+전화번호는 맞아도 이 앱 사용 권한이 없으면 로그인 실패로 처리 (잠금 카운트에도 반영)
  if (matched && !isAppAllowed(matched.data(), appId)) {
    console.warn(`[로그인] ${cleanName}은(는) "${appId}" 앱 사용 권한 없음 (allowed_apps 확인)`);
    matched = null;
  }

  // [향후 확장 지점] UserDB 문서에 password_hash 필드가 생기면 여기서 비밀번호 검증 추가.
  // 지금은 어떤 계정도 password_hash가 없어 이 분기는 타지 않음 — 이름+전화번호만으로 통과.
  // 도입 시: functions/package.json에 "bcryptjs" 추가 후
  //   const bcrypt = require("bcryptjs");
  //   const ok = await bcrypt.compare(password || "", matched.data().password_hash);
  //   if (!ok) matched = null;
  if (matched && matched.data().password_hash) {
    console.warn(`[로그인] ${cleanName} 계정에 password_hash가 있으나 검증 로직 미구현 — bcryptjs 추가 필요`);
  }

  // 3) 시도 카운트 갱신 (성공이면 리셋, 실패면 증가) — 이름 단위 + IP 단위 둘 다 반영
  const lockResult = await registerLoginResult(lockRef, !!matched);
  if (ipLockRef) {
    await registerLoginResult(ipLockRef, !!matched, IP_MAX_ATTEMPTS, IP_LOCKOUT_MINUTES);
  }

  // 4) 성공/실패 무관하게 항상 기록
  await logLoginAttempt({
    name: cleanName, phone: cleanPhone, ip, userAgent,
    success: !!matched, blocked: false,
    matchedCenter: matched ? matched.data().center_name : null,
    app: appId,
  });

  if (!matched) {
    if (lockResult.justLocked) {
      throw new HttpsError("resource-exhausted", `로그인 시도가 너무 많습니다. ${LOGIN_LOCKOUT_MINUTES}분 후 다시 시도하세요.`);
    }
    const leftMsg = lockResult.attemptsLeft != null ? ` (남은 시도 ${lockResult.attemptsLeft}회)` : "";
    throw new HttpsError("unauthenticated", `이름 또는 전화번호가 일치하지 않습니다.${leftMsg}`);
  }

  // 5) 성공 — Custom Token 발급 (커스텀 클레임에 center_name/active/name/apps 포함)
  const userData = matched.data();
  const token = await admin.auth().createCustomToken(matched.id, {
    name: userData.name || cleanName,
    center_name: userData.center_name || "",
    active: userData.active === true,
    apps: userData.allowed_apps || null, // null이면 "전체 허용" 의미 (isAppAllowed와 동일 규칙)
  });

  return {
    token,
    user: {
      name: userData.name || cleanName,
      center_name: userData.center_name || "",
      active: userData.active === true,
      email: userData.email || "",
      allowed_apps: userData.allowed_apps || null,
    },
  };
});



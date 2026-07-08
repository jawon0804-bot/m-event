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

function makeEmailHtml({ title, center_name, facility_id, fid_name, worker, datetime, memo, actionUrl }) {
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
        <tr><td style="padding:8px 0;color:#6b7280">점검자</td><td style="padding:8px 0;color:#111">${escHtml(worker)}</td></tr>
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
        makeEmailHtml({ title: "🟡 이벤트 조치가 시작되었습니다", center_name, facility_id, worker: lastHistory.by || "", datetime, memo: lastHistory.content || "", actionUrl: eventUrl }));
    } else if (after.status === "완료") {
      await sendMail(adminEmails, `[이벤트 완료] ${center_name} - ${facility_id} - ${memo}`,
        makeEmailHtml({ title: "🟢 이벤트가 완료 처리되었습니다", center_name, facility_id, worker: lastHistory.by || "", datetime, memo: lastHistory.content || "", actionUrl: eventUrl }));
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
// (열 너비/행 높이/병합 범위/셀 값·서식까지 그대로 복사 — ExcelJS는 워크북 간 시트 이동을
//  직접 지원하지 않아 셀 단위로 복사함)
function cloneTemplateSheet(targetWorkbook, tplSheet, sheetName) {
  const ws = targetWorkbook.addWorksheet(sheetName, { views: tplSheet.views });

  ws.columns = tplSheet.columns.map(col => ({ width: col?.width }));

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

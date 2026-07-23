// lib/report-export.js
// [이벤트 보고서] events → 센터별 EVENT LIST 엑셀 파일
//
// 두 진입점이 같은 빌더(buildReportWorkbook)를 공유한다:
//   1. generateEventReport   : 보고서 탭 "매핑" 버튼 — 센터/상태/기간(최대 1년) 필터를 받아
//                              온디맨드로 생성, report/{center}/{start}~{end}_매핑.xlsx 로 저장
//   2. eventReportMonthlyExport : 매달 1일 00:00(Asia/Seoul) 자동 — 필터 없이 전월 전체를
//                              센터별로 report/{center}/{y}년_{m}월_이벤트보고서.xlsx 로 저장
// 둘 다 같은 Storage 폴더(report/{center}/)에 쌓이고, listEventReportFiles가 그 폴더를
// 나열해서 "다운로드" 버튼이 파일을 고를 수 있게 한다.
//
// 템플릿(templates/report/event.xlsx)은 모든 센터가 공유하는 1개 파일이며, 라벨/서식/병합은
// 이미 갖고 있으므로 여기서는 절대 새로 만들지 않고 정해진 좌표에 "값만" 채운다
// (worklog-export.js와 동일한 원칙).
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const ExcelJS = require("exceljs");
const { admin, db, bucket } = require("./firebase");
const { getKstDateParts } = require("./dateUtils");
const {
  REPORT_TEMPLATE_PATH, REPORT_TEMPLATE_SHEET, REPORT_DATA_START_ROW,
  REPORT_MAX_ROWS, REPORT_PHOTO_SIZE_PX, REPORT_STATUS_COLOR,
  REPORT_ROW_MIN_HEIGHT_PT, REPORT_TEXT_COL_WIDTH,
} = require("../config/constants");

// ==============================================================================
// 공통 유틸
// ==============================================================================

// Firestore Timestamp/Date → "YYYY.MM.DD HH:mm" (KST, 프런트 utils.js의 fmtDate와 동일 규칙)
function fmtTimestampKst(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}

// "YYYY-MM-DD" 형태의 KST 달력일 하루 범위를 UTC Date로 변환 (KST는 고정 +09:00, DST 없음)
function kstDayRange(dateStr) {
  return {
    start: new Date(`${dateStr}T00:00:00+09:00`),
    end: new Date(`${dateStr}T23:59:59.999+09:00`),
  };
}

// 제목: 같은 해면 종료일의 "년"을 생략, 해가 걸치면 종료일에도 "년"을 붙인다
// (2026-07-22 대화에서 확정 — 연도 생략 시 "12월~3월"처럼 해가 뒤바뀌어 보이는 걸 방지)
function formatTitleRange(startStr, endStr) {
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const p2 = n => String(n).padStart(2, "0");
  const endPart = sy === ey
    ? `${p2(em)} 월 ${p2(ed)}일`
    : `${ey} 년 ${p2(em)} 월 ${p2(ed)}일`;
  return `${sy} 년 ${p2(sm)} 월 ${p2(sd)} 일 ~ ${endPart}`;
}

function buildTitle(startStr, endStr, center) {
  return `${formatTitleRange(startStr, endStr)}   ${center}센터   시설설비   EVENT LIST`;
}

// events.history 배열에서 최초 발생(memo)과 이후 조치 이력(진행현황 텍스트)을 분리
// ※ 최초 발생 내용은 history[0]이 아니라 이벤트 문서 자체의 memo 필드를 그대로 씀
//   (events-tab.js 모달의 제목도 currentEvent.memo를 씀 — 두 군데가 어긋나지 않게 통일)
// [2026-07-23] 일시 뒤에 작성자(*이름*)를 붙임 — 누가 조치/완료 처리했는지 J열만 보고도 알 수 있게
function buildProgressText(history) {
  const list = Array.isArray(history) ? history : [];
  return list
    .filter(h => h.type !== "발생")
    .map(h => {
      const ts = h.by ? `${fmtTimestampKst(h.at)} *${h.by}*` : fmtTimestampKst(h.at);
      return `${ts}\n${h.content || ""}`;
    })
    .join("\n");
}

// events-tab.js의 fmtDate 표시 규칙과 다르게, 템플릿 C열은 "날짜\n  시간" 2줄 형태
// (event.xlsx 실측: '2026-07-10\n  13:25'). ev.datetime은 "YYYY-MM-DD HH:mm" 문자열.
function formatDatetimeCell(datetime) {
  const [d, t] = String(datetime || "").split(" ");
  return t ? `${d}\n  ${t}` : (d || "");
}

// [2026-07-23] I(상황발생 내용)/J(진행현황) 글자가 길면 셀보다 내용이 넘쳐 보이던 문제 —
// 실제 텍스트 레이아웃 엔진은 없으니 "열 너비 단위 ≈ 글자 수"로 대략 줄 수를 추정해서
// 필요한 줄 수만큼 행 높이를 늘린다. 평소(사진 들어가는 짧은 내용)엔 최소 높이 그대로.
const REPORT_LINE_HEIGHT_PT = 16; // 12pt 폰트 기준 대략적인 줄 간격
function estimateTextLines(text, colWidthUnits) {
  if (!text) return 0;
  const charsPerLine = Math.max(1, Math.floor(colWidthUnits));
  return String(text).split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}
function computeRowHeight(memo, progressText) {
  const iLines = estimateTextLines(memo, REPORT_TEXT_COL_WIDTH.I);
  const jLines = estimateTextLines(progressText, REPORT_TEXT_COL_WIDTH.J);
  const neededHeight = Math.max(iLines, jLines) * REPORT_LINE_HEIGHT_PT + 10; // 여백
  return Math.max(REPORT_ROW_MIN_HEIGHT_PT, neededHeight);
}

function guessImageExtension(url) {
  const m = /\.(jpe?g|png|gif)(\?|$)/i.exec(url || "");
  if (!m) return "jpeg";
  const ext = m[1].toLowerCase();
  return ext === "jpg" ? "jpeg" : ext;
}

// events-tab.js의 loadEventPhotos와 동일한 2단계 해석 로직을 서버에서 재현:
//   ① photos 필드(콤마구분 다운로드 URL)가 있으면 그대로 fetch
//   ② 없으면 photo_count만큼 Storage 경로 패턴으로 직접 download (Admin SDK라 토큰 불필요)
async function resolvePhotoBuffers(ev) {
  const out = [];
  const urls = String(ev.photos || "").split(",").map(s => s.trim()).filter(Boolean);
  if (urls.length > 0) {
    for (const url of urls.slice(0, 3)) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        out.push({ buffer: Buffer.from(await res.arrayBuffer()), extension: guessImageExtension(url) });
      } catch (e) {
        console.warn("[이벤트 보고서] 사진 다운로드 실패(URL):", url, e.message);
      }
    }
    return out;
  }

  const count = Math.min(parseInt(String(ev.photo_count ?? "0").replace(/[^0-9]/g, ""), 10) || 0, 3);
  if (count === 0) return out;
  const dt = String(ev.datetime || "").replace(/[-: ]/g, "").slice(0, 12);
  const facilityId = String(ev.facility_id || "").replace(/\s/g, "_");
  for (let i = 1; i <= count; i++) {
    const fileName = `${dt.slice(0, 8)}_${dt.slice(8, 12)}_${facilityId}_${i}.jpg`;
    const path = `inspection_photos/${ev.center_name}/${fileName}`;
    try {
      const [buf] = await bucket.file(path).download();
      out.push({ buffer: buf, extension: "jpeg" });
    } catch (e) {
      console.warn("[이벤트 보고서] 사진 다운로드 실패(Storage):", path, e.message);
    }
  }
  return out;
}

async function embedPhotos(workbook, ws, rowNumber, photos) {
  for (let i = 0; i < Math.min(photos.length, 3); i++) {
    const imageId = workbook.addImage({ buffer: photos[i].buffer, extension: photos[i].extension });
    ws.addImage(imageId, {
      tl: { col: 5 + i, row: rowNumber - 1 }, // F=col5(0-idx), G=6, H=7
      ext: { width: REPORT_PHOTO_SIZE_PX, height: REPORT_PHOTO_SIZE_PX },
      editAs: "oneCell",
    });
  }
}

// ==============================================================================
// 템플릿 로드 (매번 새 워크북으로 fresh load — 이후 그대로 수정해서 저장하므로
// Storage의 원본 템플릿 자체는 건드리지 않음)
// ==============================================================================
async function loadReportWorkbook() {
  const file = bucket.file(REPORT_TEMPLATE_PATH);
  const [exists] = await file.exists();
  if (!exists) throw new Error(`보고서 템플릿 없음: ${REPORT_TEMPLATE_PATH}`);
  const buf = await file.download();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf[0]);
  const ws = wb.getWorksheet(REPORT_TEMPLATE_SHEET);
  if (!ws) throw new Error(`템플릿에 "${REPORT_TEMPLATE_SHEET}" 시트 없음: ${REPORT_TEMPLATE_PATH}`);
  return { wb, ws };
}

// ==============================================================================
// events 조회 — center_name(필수) + status(선택) + created_at 범위(YYYY-MM-DD, 선택)
// ⚠️ center_name/status 동시 필터 + created_at range/orderBy 조합이라 Firestore 콘솔에서
//   복합 색인을 요구할 수 있음 — 첫 실행 시 에러 메시지의 색인 생성 링크로 만들면 됨.
// ==============================================================================
async function queryEvents({ center, status, start, end }) {
  let q = db.collection("events").where("center_name", "==", center);
  if (status) q = q.where("status", "==", status);
  if (start) q = q.where("created_at", ">=", admin.firestore.Timestamp.fromDate(kstDayRange(start).start));
  if (end) q = q.where("created_at", "<=", admin.firestore.Timestamp.fromDate(kstDayRange(end).end));
  q = q.orderBy("created_at", "desc");
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ==============================================================================
// 워크북 빌더 — 정렬/100건 캡/106행 초과안내까지 여기서 전부 처리
// events는 이미 created_at desc로 정렬된 상태로 들어온다고 가정 (queryEvents 결과)
// ==============================================================================
async function buildReportWorkbook({ center, start, end, events }) {
  const { wb, ws } = await loadReportWorkbook();

  // [2026-07-23 버그 수정] 템플릿이 고정 배율(scale=43%)을 쓰고 있어서, 사진을 6cm로
  // 키우며 F~H열이 넓어지자 K열(상태)이 두 번째 페이지로 밀려 잘리는 문제가 있었음.
  // 고정 배율 대신 "가로 1페이지에 맞춤"으로 바꿔서 열 너비가 또 바뀌어도 항상 한 페이지
  // 폭 안에 들어가게 함 (세로는 필요한 만큼 여러 페이지 허용).
  ws.pageSetup.fitToPage = true;
  ws.pageSetup.fitToWidth = 1;
  ws.pageSetup.fitToHeight = 0;

  ws.getCell("A1").value = buildTitle(start, end, center);

  const total = events.length;
  const mapped = events.slice(0, REPORT_MAX_ROWS);

  for (let i = 0; i < mapped.length; i++) {
    const ev = mapped[i];
    const row = REPORT_DATA_START_ROW + i;
    const progressText = buildProgressText(ev.history);
    ws.getCell(row, 2).value = ev.center_name || "";                       // B 센터명
    ws.getCell(row, 3).value = formatDatetimeCell(ev.datetime);            // C 발생일시
    ws.getCell(row, 4).value = ev.fid_name || ev.facility_id || "";        // D 설비/위치
    ws.getCell(row, 5).value = ev.worker || "";                           // E 점검자
    ws.getCell(row, 9).value = ev.memo || "";                             // I 상황발생 내용
    ws.getCell(row, 10).value = progressText;                             // J 진행현황

    const statusCell = ws.getCell(row, 11);                               // K 상태
    const lastHistory = Array.isArray(ev.history) && ev.history.length > 0
      ? ev.history[ev.history.length - 1] : null;                        // 현재 상태로 바뀐 시점
    const statusAt = lastHistory ? fmtTimestampKst(lastHistory.at) : "";
    statusCell.value = statusAt ? `${ev.status || ""}\n${statusAt}` : (ev.status || "");
    statusCell.font = {
      name: "맑은 고딕", size: 12,
      color: { argb: REPORT_STATUS_COLOR[ev.status] || "FF000000" },
    };

    // [2026-07-23] 상황발생 내용/진행현황이 길어서 셀보다 넘치면 행 높이를 늘림 —
    // 평소(사진 들어가는 짧은 내용)엔 사진 기준 최소 높이 그대로.
    ws.getRow(row).height = computeRowHeight(ev.memo, progressText);

    const photos = await resolvePhotoBuffers(ev);
    await embedPhotos(wb, ws, row, photos);
  }

  // [2026-07-23 버그 수정] ExcelJS spliceRows()가 요청한 만큼 행을 실제로 지우지 못하는
  // 문제를 확인함(값은 옮겨지는데 실제 행 개수/치수가 거의 안 줄어듦) — "지우는" 대신
  // "숨기고" 인쇄범위로 실제 찍히는 범위만 제한하는 방식으로 바꿈. 안 쓰는 행이 숨겨지고
  // 106행(초과 안내)도 더 이상 splice로 밀려 올라오지 않아 위치가 항상 고정.
  const lastFilledRow = REPORT_DATA_START_ROW + mapped.length - 1;
  const lastTemplateRow = REPORT_DATA_START_ROW + REPORT_MAX_ROWS - 1; // 105
  const OVERFLOW_ROW = REPORT_DATA_START_ROW + REPORT_MAX_ROWS;        // 106, 고정 위치

  for (let r = lastFilledRow + 1; r <= lastTemplateRow; r++) {
    ws.getRow(r).hidden = true;
  }

  let finalLastRow;
  if (total > REPORT_MAX_ROWS) {
    ws.getCell(OVERFLOW_ROW, 1).value =
      `⚠️ 조회 기간 내 이벤트가 ${total}건으로 100건을 초과하여 최신 100건만 표시되었습니다. ` +
      `(초과 ${total - REPORT_MAX_ROWS}건 · 기간을 좁혀 다시 조회해주세요)`;
    finalLastRow = OVERFLOW_ROW;
  } else {
    ws.getRow(OVERFLOW_ROW).hidden = true;
    finalLastRow = lastFilledRow;
  }

  // 매핑 후 실제 마지막 행 기준으로 인쇄범위를 매번 다시 계산해서 맞춘다
  // (템플릿 원본값 "A1:K106"에 고정돼 있으면 실제 데이터와 어긋남).
  ws.pageSetup.printArea = `A1:K${finalLastRow}`;

  return wb;
}

// ==============================================================================
// [진입점 1] generateEventReport — 보고서 탭 "매핑" 버튼 (Callable)
// ==============================================================================
exports.generateEventReport = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const claims = request.auth.token;
  const isMaster = claims.center_name === "Master";
  const isAdminOrMaster = claims.active === true || isMaster;
  if (!isAdminOrMaster) throw new HttpsError("permission-denied", "권한이 없습니다.");

  const { center, status, start, end } = request.data || {};
  if (!start || !end) throw new HttpsError("invalid-argument", "조회 기간을 입력하세요.");
  const days = (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24);
  if (Number.isNaN(days) || days < 0 || days > 366) {
    throw new HttpsError("invalid-argument", "조회 기간은 최대 1년까지 가능합니다.");
  }

  // 센터 지정 시 본인 센터인지 확인, 미지정("전체")은 Master만 허용 → 전체 센터 순회
  let targetCenters;
  if (center) {
    if (!isMaster && center !== claims.center_name) {
      throw new HttpsError("permission-denied", "다른 센터의 보고서는 생성할 수 없습니다.");
    }
    targetCenters = [center];
  } else {
    if (!isMaster) throw new HttpsError("invalid-argument", "센터를 선택하세요.");
    const doc = await db.collection("settings").doc("all_centers").get();
    targetCenters = doc.exists ? (doc.data().centers || []) : [];
  }

  const results = [];
  for (const c of targetCenters) {
    try {
      const events = await queryEvents({ center: c, status, start, end });
      if (events.length === 0) { results.push({ center: c, skipped: true }); continue; }

      const wb = await buildReportWorkbook({ center: c, start, end, events });
      const fileName = `${start}~${end}_매핑.xlsx`;
      const filePath = `report/${c}/${fileName}`;
      const buf = await wb.xlsx.writeBuffer();
      await bucket.file(filePath).save(buf, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      results.push({ center: c, fileName, filePath, count: events.length });
    } catch (e) {
      console.error(`[이벤트 보고서] ${c} 매핑 실패:`, e);
      results.push({ center: c, error: e.message });
    }
  }
  return { results };
});

// ==============================================================================
// [진입점 2] eventReportMonthlyExport — 매달 1일 00:00(Asia/Seoul) 자동, 전월 전체
// ==============================================================================
exports.eventReportMonthlyExport = onSchedule(
  { schedule: "0 0 1 * *", timeZone: "Asia/Seoul", timeoutSeconds: 540, memory: "512MiB" },
  async () => {
    const today = getKstDateParts(new Date());
    // "전월" 1일 — UTC 연산으로 연/월 경계 자동 처리 (worklog-export.js와 동일 패턴)
    const first = new Date(Date.UTC(today.y, today.m - 2, 1));
    const py = first.getUTCFullYear(), pm = first.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate(); // pm월의 말일
    const p2 = n => String(n).padStart(2, "0");
    const start = `${py}-${p2(pm)}-01`;
    const end = `${py}-${p2(pm)}-${p2(lastDay)}`;

    let centers = [];
    try {
      const doc = await db.collection("settings").doc("all_centers").get();
      centers = doc.exists ? (doc.data().centers || []) : [];
    } catch (e) {
      console.error("[이벤트 보고서 월간] 센터 목록 조회 실패:", e);
      return null;
    }

    console.log(`[이벤트 보고서 월간] 대상 기간: ${start}~${end}, 센터 ${centers.length}곳`);

    for (const center of centers) {
      try {
        const events = await queryEvents({ center, status: "", start, end });
        if (events.length === 0) {
          console.log(`[이벤트 보고서 월간] ${center} 해당 월 이벤트 없음, 스킵`);
          continue;
        }
        const wb = await buildReportWorkbook({ center, start, end, events });
        const filePath = `report/${center}/${py}년_${pm}월_이벤트보고서.xlsx`;
        const buf = await wb.xlsx.writeBuffer();
        await bucket.file(filePath).save(buf, {
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        console.log(`[이벤트 보고서 월간] ${filePath} 완료 (${events.length}건)`);
      } catch (e) {
        console.error(`[이벤트 보고서 월간] ${center} 처리 실패 (다른 센터는 계속 진행):`, e);
      }
    }
    return null;
  }
);

// ==============================================================================
// [부가] listEventReportFiles — 보고서 탭 "다운로드" 버튼이 파일 목록을 고를 수 있게
// (client-side Storage listAll() 대신 Admin SDK로 서명 URL까지 만들어 반환 —
//  storage.rules를 별도로 열어줄 필요가 없고, UserDB 등과 동일하게 민감한 목록 조회는
//  Admin SDK 경유로 통일하는 이 코드베이스의 방침과도 맞음)
// ==============================================================================
exports.listEventReportFiles = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const claims = request.auth.token;
  const isMaster = claims.center_name === "Master";
  const isAdminOrMaster = claims.active === true || isMaster;
  if (!isAdminOrMaster) throw new HttpsError("permission-denied", "권한이 없습니다.");

  const { center } = request.data || {};
  const targetCenter = center || (!isMaster ? claims.center_name : "");
  if (!targetCenter) throw new HttpsError("invalid-argument", "센터를 선택하세요.");
  if (!isMaster && targetCenter !== claims.center_name) {
    throw new HttpsError("permission-denied", "다른 센터의 파일은 조회할 수 없습니다.");
  }

  const [files] = await bucket.getFiles({ prefix: `report/${targetCenter}/` });
  const list = await Promise.all(files.map(async f => {
    const [meta] = await f.getMetadata();
    const [url] = await f.getSignedUrl({ action: "read", expires: Date.now() + 10 * 60 * 1000 });
    return { name: f.name.split("/").pop(), path: f.name, size: Number(meta.size) || 0, updated: meta.updated, url };
  }));
  list.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  return { files: list };
});

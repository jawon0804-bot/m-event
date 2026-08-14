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
const { fixSheetPrOrder } = require("./excel-utils");
const { isMaster: isMasterOf, isAdmin } = require("./permissions");
const {
  REPORT_TEMPLATE_PATH, REPORT_TEMPLATE_SHEET, REPORT_DATA_START_ROW,
  REPORT_MAX_ROWS, REPORT_LAST_COL, REPORT_PHOTO_SIZE_PX, REPORT_STATUS_COLOR,
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
// [2026-07-23] 일시 뒤에 작성자(*이름*)를 붙임 — 누가 조치/완료 처리했는지 I열만 보고도 알 수 있게
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

// events-tab.js의 fmtDate 표시 규칙과 다르게, 템플릿 B열은 "날짜\n  시간" 2줄 형태
// (event.xlsx 실측: '2026-07-10\n  13:25'). ev.datetime은 "YYYY-MM-DD HH:mm" 문자열.
function formatDatetimeCell(datetime) {
  const [d, t] = String(datetime || "").split(" ");
  return t ? `${d}\n  ${t}` : (d || "");
}

// ──────────────────────────────────────────────────────────────────────────────
// [2026-08-14] 행 높이는 **템플릿 값(6~106행 170.85pt = 6cm 사진 기준)을 그대로 쓴다.**
// 여기서 아무것도 안 하는 게 의도다 — 되돌리기 전에 아래를 읽을 것.
//
// 2026-07-23~2026-08-14에는 상황발생 내용/진행현황 글자 수로 줄 수를 추정해서 행을
// 늘렸다(estimateTextLines/computeRowHeight). 그런데 그 추정이 한글에서 실제의 절반이라
// 늘려도 여전히 잘렸다 — Excel 16.0 실측 기준:
//   · 열 너비 단위는 "숫자 0 한 글자" 폭이라 한글은 2칸을 먹는다
//     (진행현황 열 너비 70.625에 한글은 35자만 들어가는데 코드는 70자로 셌다)
//   · 맑은 고딕 12pt 한 줄은 16pt가 아니라 17.25pt
//   → 조치 이력 3건(실제 필요 207pt)을 170.8pt로 잡아서 2줄이 잘려 나갔다.
// 반쯤 맞는 높이를 계산하느니 사진 크기에 맞춘 고정 높이로 두고, 내용이 길어 잘리면
// 파일을 받은 관리자가 직접 늘리는 쪽이 낫다는 판단이다(2026-08-14 결정).
//
// 나중에 이걸 다시 자동화한다면 참고할 것:
//   · 셀 값 자체는 온전하다. 잘리는 건 표시뿐이고, 행 높이만 늘리면 다시 보인다.
//   · 템플릿 서식이 "세로 가운데"라 잘릴 때 위아래가 같이 잘린다(뒤쪽만이 아니다).
//   · Excel 행 높이 상한이 409.5pt(약 23줄)라, 조치 이력이 6건쯤 넘으면 높이를
//     아무리 키워도 다 못 보여준다. 그건 높이가 아니라 양식으로 풀어야 하는 문제다.
//   · 높이를 아예 안 쓰면(ht/customHeight 미기록) Excel이 열 때 자동 맞춤을 해 준다.
//     단 자동 맞춤은 **그림을 계산에 안 넣어서** 내용이 짧은 행은 69pt로 줄어들고
//     6cm 사진이 아래 행을 침범한다 — 사진이 들어가는 이 양식에선 그대로 못 쓴다.
// ──────────────────────────────────────────────────────────────────────────────

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
  // [2026-07-29 수정] 파일을 실제로 쓰는 M-SMART(public/js/submit.js)의 cleanFid와
  // 동일한 규칙. 예전엔 `replace(/\s/g,"_")`(공백→밑줄)이라 M-SMART가 만든 실제
  // 파일명과 어긋났다 — 설비ID에 공백/특수문자가 있으면 사진을 못 찾았다.
  // Dashboard lib/photoNaming.js, events-tab.js와 같이 유지할 것.
  const facilityId = String(ev.facility_id || "").replace(/[/\\?%*:|"<>\s]/g, "");
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
      tl: { col: 4 + i, row: rowNumber - 1 }, // E=col4(0-idx), F=5, G=6
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
//
// 이 조합에 필요한 복합 색인 2개는 `firestore.indexes.json`에 등재되어 있고 CI가 함께
// 배포한다 (events: center_name+created_at DESC / center_name+status+created_at DESC).
//
// ⚠️ [2026-07-29 정정] 여기엔 "첫 실행 시 에러 메시지의 색인 생성 링크로 만들면 됨"이라고
//   적혀 있었는데, 그건 system_map.md 4번 체크리스트가 **명시적으로 금지한 절차**다 —
//   링크로 만드는 사이 쿼리가 FAILED_PRECONDITION으로 조용히 실패하고, 이 저장소 계열에서
//   실제로 그 사고가 여러 번 있었다. 새 쿼리를 추가하면 firestore.indexes.json에 먼저
//   등재하고 배포한 뒤 코드를 내보낼 것.
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
  // [2026-07-23 버그 수정] "내용에 문제가 있습니다" 손상 경고의 원인 2가지를 같이 정리:
  //  1. fitToPage를 켰는데도 템플릿의 옛 고정배율(scale=43)이 그대로 남아 fitToWidth/
  //     fitToHeight와 함께 쓰여서 충돌 — fitToPage 켤 땐 scale을 지워야 함
  //  2. 템플릿 원본의 horizontalDpi/verticalDpi 값이 4294967295(비정상)로 저장돼 있던
  //     걸 ExcelJS가 그대로 다시 씀 — 정상적인 값으로 바로잡음
  ws.pageSetup.scale = undefined;
  ws.pageSetup.horizontalDpi = 600;
  ws.pageSetup.verticalDpi = 600;

  ws.getCell("A1").value = buildTitle(start, end, center);

  const total = events.length;
  const mapped = events.slice(0, REPORT_MAX_ROWS);

  for (let i = 0; i < mapped.length; i++) {
    const ev = mapped[i];
    const row = REPORT_DATA_START_ROW + i;
    // [2026-08-14 양식 개편] 센터명 열이 없어져서 좌표가 한 칸씩 당겨졌다.
    // 센터는 제목(A1)에 이미 들어가므로 정보가 빠지는 건 아니다.
    // J·K(완료사진1~2)는 관리자가 파일을 받은 뒤 직접 넣는 자리라 코드는 건드리지 않는다.
    ws.getCell(row, 2).value = formatDatetimeCell(ev.datetime);            // B 발생일시
    ws.getCell(row, 3).value = ev.fid_name || ev.facility_id || "";        // C 설비/위치
    ws.getCell(row, 4).value = ev.worker || "";                           // D 점검자
    ws.getCell(row, 8).value = ev.memo || "";                             // H 상황발생 내용
    ws.getCell(row, 9).value = buildProgressText(ev.history);             // I 진행현황

    const statusCell = ws.getCell(row, 12);                               // L 상태
    const lastHistory = Array.isArray(ev.history) && ev.history.length > 0
      ? ev.history[ev.history.length - 1] : null;                        // 현재 상태로 바뀐 시점
    const statusAt = lastHistory ? fmtTimestampKst(lastHistory.at) : "";
    statusCell.value = statusAt ? `${ev.status || ""}\n${statusAt}` : (ev.status || "");
    statusCell.font = {
      name: "맑은 고딕", size: 12,
      color: { argb: REPORT_STATUS_COLOR[ev.status] || "FF000000" },
    };

    // 행 높이는 템플릿 값을 그대로 둔다 (위 "행 높이" 주석 참고 — 의도된 무동작)

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
  // (템플릿 원본값 "A1:L106"에 고정돼 있으면 실제 데이터와 어긋남).
  // ExcelJS가 printArea 문자열을 쓸 때 열(A/L)엔 "$"를 자동으로 붙이면서 행 번호엔 안
  // 붙이는 버릇이 있어서, 행 번호 쪽에 "$"를 직접 넣어 정상적인 "$A$1:$L$7" 형태로 나오게 함
  // (이 자체가 손상 경고의 원인은 아니었지만 — 진짜 원인은 아래 writeReportBuffer 참고 —
  //  절대참조 형태를 맞춰두는 게 맞아서 그대로 둠).
  ws.pageSetup.printArea = `A$1:${REPORT_LAST_COL}$${finalLastRow}`;

  return wb;
}

// ==============================================================================
// [2026-07-23 버그 수정] "내용에 문제가 있습니다(복구하시겠습니까?)" 경고의 진짜 원인.
// buildReportWorkbook에서 ws.pageSetup.fitToPage = true를 켜면, ExcelJS가 기존
// <sheetPr>에 <pageSetUpPr>을 끼워 넣으면서 <outlinePr>보다 앞에 써버림
// (실제: <pageSetUpPr/><outlinePr/> / OOXML이 요구하는 순서: <outlinePr/><pageSetUpPr/>).
// CT_SheetPr는 자식 순서를 엄격히 강제하는 타입이라 이 순서 위반만으로 엑셀이 파일을
// 손상됐다고 판단함 — ExcelJS 자체 버그라 라이브러리 옵션으로는 못 피하고, 저장된
// buffer의 XML을 직접 열어서 두 태그 순서를 바꾼 뒤 다시 압축하는 방식으로 우회한다.
// (fitToPage를 계속 켜 놓고 있으니 매핑/월간 자동생성 양쪽 다 이 후처리를 거쳐야 함.)
//
// [2026-07-27] 이 후처리는 lib/excel-utils.js의 fixSheetPrOrder로 옮겼다. 예전 버전은
// "xl/worksheets/sheet1.xml" 하나만 고쳤는데, 시트가 여러 개인 엑셀 탭 통합 다운로드에서는
// 나머지 시트가 전부 안 고쳐진 채 남기 때문에 워크시트 전체를 도는 버전으로 일반화했다.
// 이벤트 보고서는 시트가 1개라 결과는 예전과 동일하다.
// ==============================================================================
async function writeReportBuffer(wb) {
  const buf = await wb.xlsx.writeBuffer();
  return fixSheetPrOrder(buf, "[이벤트 보고서]");
}

// ==============================================================================
// [진입점 1] generateEventReport — 보고서 탭 "매핑" 버튼 (Callable)
// ==============================================================================
exports.generateEventReport = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const claims = request.auth.token;
  const isMaster = isMasterOf(claims);
  // [2026-08-01] `claims.active === true || isMaster` → lib/permissions.js의 isAdmin으로 통일.
  //   · 옛 토큰(role 없음)은 그 안의 폴백이 active로 판정하므로 재로그인 전에도 안 깨진다.
  //   · **Master를 OR로 묶지 않는다** — 묶으면 center_name이 '범위'와 '권한'을 겸하게 되어
  //     "전 센터를 열람하되 보고서는 만들지 않는 계정"을 표현할 수 없다. Master 계정도
  //     보고서를 만들려면 UserDB에 role:"admin"이 있어야 한다(전환기엔 폴백이 통과시킴).
  //   아래 isMaster는 권한이 아니라 **어느 센터를 대상으로 할지**를 정하는 데만 쓴다.
  if (!isAdmin(claims)) throw new HttpsError("permission-denied", "권한이 없습니다.");

  const { center, status, start, end } = request.data || {};
  if (!start || !end) throw new HttpsError("invalid-argument", "조회 기간을 입력하세요.");
  const days = (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24);
  if (Number.isNaN(days) || days < 0 || days > 366) {
    throw new HttpsError("invalid-argument", "조회 기간은 최대 1년까지 가능합니다.");
  }

  // 센터는 **필수**다.
  //
  // ⚠️ [2026-08-05] 예전엔 미지정("전체")을 Master에게만 허용하고 `settings/all_centers`를
  //   읽어 **전 센터를 순회**하며 센터마다 보고서를 만들었다. 보고서 생성은 이벤트 조회 +
  //   사진 임베딩 + xlsx 작성 + Storage 업로드가 센터마다 도는 무거운 작업이라, 센터가
  //   늘면 한 번의 호출이 그만큼 길어진다(실사용 목표는 최대 50개소).
  //   화면도 같은 날 센터 선택을 필수로 바꿨는데, **서버가 계속 받아주면 옛 화면·직접 호출로
  //   그 경로가 그대로 산다.** 그래서 여기서도 막는다.
  if (!center) throw new HttpsError("invalid-argument", "센터를 선택하세요.");
  if (!isMaster && center !== claims.center_name) {
    throw new HttpsError("permission-denied", "다른 센터의 보고서는 생성할 수 없습니다.");
  }
  const targetCenters = [center];

  const results = [];
  for (const c of targetCenters) {
    try {
      const events = await queryEvents({ center: c, status, start, end });
      if (events.length === 0) { results.push({ center: c, skipped: true }); continue; }

      const wb = await buildReportWorkbook({ center: c, start, end, events });
      const fileName = `${start}~${end}_매핑.xlsx`;
      const filePath = `report/${c}/${fileName}`;
      const buf = await writeReportBuffer(wb);
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
        const buf = await writeReportBuffer(wb);
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
  const isMaster = isMasterOf(claims);
  if (!isAdmin(claims)) throw new HttpsError("permission-denied", "권한이 없습니다.");

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

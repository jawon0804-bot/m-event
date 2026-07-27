// lib/excel-merge.js
// [엑셀 탭] "파일 병합" — 목록에서 체크한 Maxerve_Excel 점검표들을 워크북 1개로 병합
//
// M-Engine이 만드는 점검표 엑셀은 파일당 시트가 정확히 1개다
// (M-Engine/excel_writer.py가 저장 직전에 나머지 시트를 전부 제거한다).
// 덕분에 "파일 N개 → 시트 N개"로 1:1 매핑된다.
//
// 왜 서버에서 합치나:
//   프런트(manager/index.html)에 이미 SheetJS가 로드돼 있어서 브라우저에서도 합칠 수 있지만,
//   SheetJS 무료판은 읽어들인 서식을 다시 쓰지 못한다 — 테두리/색/글꼴/로고가 전부 날아가고
//   값만 남은 맨 격자가 된다. 점검표는 인쇄해서 제출하는 문서라 그 결과물은 쓸 수 없어서,
//   서식을 보존하는 ExcelJS(서버)로 합친다.
//
// ⚠️ 보안: 클라이언트가 보낸 파일 경로를 그대로 믿지 않는다. 받는 건 문서 ID 목록뿐이고,
//   서버가 그 ID로 Firestore를 직접 읽은 뒤 각 문서의 center_name이 요청 센터와 같은지
//   다시 대조한다. 클라이언트가 임의의 Storage 경로를 넣어 남의 센터 파일을 받아가는
//   경로를 아예 만들지 않기 위함.
//
// ⚠️ 색인: 문서 ID 직접 조회(getAll)만 쓰므로 복합 색인이 필요 없다 —
//   system_map.md가 반복 지적하는 "배포 후 FAILED_PRECONDITION" 함정에 걸리지 않는다.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const ExcelJS = require("exceljs");
const { db, bucket } = require("./firebase");
const { cloneSheet, fixSheetPrOrder, loadWorkbookTolerant } = require("./excel-utils");
const {
  EXCEL_MERGE_MAX_FILES,
  EXCEL_MERGE_DOWNLOAD_CONCURRENCY,
  EXCEL_MERGE_STORAGE_PREFIX,
} = require("../config/constants");

const LOG = "[엑셀 통합]";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ==============================================================================
// 선택된 문서 ID로 조회
//
// 클라이언트는 "어떤 문서를 합칠지"를 문서 ID 목록으로만 보낸다 (Storage 경로 같은 건 안 받음).
// 서버가 그 ID로 Firestore를 직접 읽고, 호출부에서 center_name까지 다시 대조하므로
// 남의 센터 문서 ID를 섞어 보내도 그 문서는 조용히 걸러진다.
//
// getAll은 넘긴 ref 순서 그대로 돌려주므로, 화면 목록에 보이던 순서가 그대로 시트 순서가 된다.
// ==============================================================================
const GET_ALL_CHUNK = 100;

async function fetchExcelDocsByIds(ids) {
  const refs = ids.map(id => db.collection("Maxerve_Excel").doc(id));
  const out = [];
  for (let i = 0; i < refs.length; i += GET_ALL_CHUNK) {
    const snaps = await db.getAll(...refs.slice(i, i + GET_ALL_CHUNK));
    snaps.forEach(s => { if (s.exists) out.push({ id: s.id, ...s.data() }); });
  }
  return out;
}

// ==============================================================================
// 시트 이름용 라벨 — manager/js/auth.js의 loadFidLocations와 동일한 출처/우선순위
// (center_configs/{center}/inspections의 sheet_label > facilities의 fid_name > 설비ID)
// 화면 목록에 보이던 제목과 통합본의 시트 이름이 어긋나지 않게 같은 규칙을 쓴다.
// ==============================================================================
async function loadLabelMaps(center) {
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

  return { locations, labels };
}

function resolveLabel(item, { locations, labels }) {
  const fid = String(item.facility_id || "").split(",")[0].trim();
  return labels[fid] || locations[fid] || item.facility_id || "점검표";
}

// ==============================================================================
// 시트 이름 만들기 — "MM-DD_라벨"
// 엑셀 제약: 31자 이하, \ / ? * [ ] : 사용 불가, 중복 불가, 빈 문자열 불가
// ==============================================================================
const INVALID_SHEET_CHARS = /[\\/?*[\]:]/g;
const MAX_SHEET_NAME = 31;

function buildSheetName(item, labelMaps, used) {
  const monthDay = String(item.datetime || "").slice(5, 10); // "2026-07-24 09:00" → "07-24"
  const label = resolveLabel(item, labelMaps);

  let base = `${monthDay ? `${monthDay}_` : ""}${label}`
    .replace(INVALID_SHEET_CHARS, "_")
    .replace(/^'+|'+$/g, "")  // 엑셀은 시트명 앞뒤 작은따옴표를 허용하지 않음
    .trim();
  if (!base) base = "점검표";
  base = base.slice(0, MAX_SHEET_NAME);

  // 같은 날 같은 설비가 두 번 점검되면 이름이 겹칠 수 있어 _2, _3... 을 붙인다
  let name = base;
  let n = 2;
  while (used.has(name)) {
    const suffix = `_${n}`;
    name = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
    n++;
  }
  used.add(name);
  return name;
}

// ==============================================================================
// 원본 파일 다운로드
// Maxerve_Excel 문서는 지금은 storage_path(버킷 내 상대경로)를 쓰지만, 예전 문서엔
// file_url(절대 URL)만 있는 것도 있어서 프런트 resolveExcelUrl()과 같은 후보 순서로 찾는다.
// ==============================================================================
// 절대 URL로만 남아있는 구형 문서 대비 — Firebase Storage 호스트로만 요청을 제한한다
// (Firestore 문서 값이 어쩌다 외부 주소를 가리켜도 서버가 그걸 대신 긁어오지 않도록)
const ALLOWED_FETCH_HOSTS = new Set([
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
]);

async function downloadSourceBuffer(item) {
  const raw = item.file_url || item.fileUrl || item.url || item.download_url || "";
  const isAbsolute = /^https?:\/\//i.test(raw);

  const path = (isAbsolute ? "" : raw)
    || item.file_path || item.filePath || item.storage_path || item.storagePath || "";

  if (path) {
    // gs://버킷/경로 → 버킷 안 상대경로
    const objectPath = /^gs:\/\//i.test(path) ? path.replace(/^gs:\/\/[^/]+\//i, "") : path;
    const [buf] = await bucket.file(objectPath).download();
    return buf;
  }

  if (isAbsolute) {
    const host = new URL(raw).hostname;
    if (!ALLOWED_FETCH_HOSTS.has(host)) throw new Error(`허용되지 않은 호스트: ${host}`);
    const res = await fetch(raw);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  throw new Error("다운로드 경로가 없는 문서");
}

// 동시 실행 수를 제한하면서 map — 100개를 한꺼번에 받으면 메모리가 튄다
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ==============================================================================
// mergeExcelFiles — 엑셀 탭 "전체 다운로드" 버튼 (Callable)
// ==============================================================================
exports.mergeExcelFiles = onCall({ timeoutSeconds: 540, memory: "1GiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const claims = request.auth.token;
  const isMaster = claims.center_name === "Master";
  const isAdminOrMaster = claims.active === true || isMaster;
  if (!isAdminOrMaster) throw new HttpsError("permission-denied", "권한이 없습니다.");

  const { center, start, end, ids } = request.data || {};

  // Master가 센터를 "전체"로 둔 경우 — 센터마다 점검표 양식이 달라서 한 파일에 섞으면
  // 오히려 보기 나쁘다. 여기서 막고 프런트가 센터를 고르게 안내한다.
  if (!center) throw new HttpsError("invalid-argument", "센터를 선택해주세요.");
  if (!isMaster && center !== claims.center_name) {
    throw new HttpsError("permission-denied", "다른 센터의 파일은 내려받을 수 없습니다.");
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new HttpsError("invalid-argument", "합칠 점검표를 선택해주세요.");
  }
  // 중복 ID를 보내도 같은 시트가 두 번 들어가지 않게 정리
  const uniqueIds = [...new Set(ids.filter(id => typeof id === "string" && id))];
  if (uniqueIds.length === 0) {
    throw new HttpsError("invalid-argument", "합칠 점검표를 선택해주세요.");
  }
  if (uniqueIds.length > EXCEL_MERGE_MAX_FILES) {
    throw new HttpsError(
      "invalid-argument",
      `한 번에 최대 ${EXCEL_MERGE_MAX_FILES}건까지 합칠 수 있습니다. (선택 ${uniqueIds.length}건)`
    );
  }

  const fetched = await fetchExcelDocsByIds(uniqueIds);

  // ⚠️ 여기가 권한 경계다 — 클라이언트가 보낸 ID가 정말 이 센터 문서인지 서버에서 대조한다.
  //   (위에서 center 자체는 이미 본인 센터인지 확인했으므로, 이 대조를 통과하면 안전)
  const targets = fetched.filter(d => d.center_name === center);
  const rejected = fetched.length - targets.length;
  if (rejected > 0) {
    console.warn(`${LOG} 다른 센터 문서 ${rejected}건이 요청에 섞여 있어 제외함 (요청 센터=${center})`);
  }

  if (targets.length === 0) {
    throw new HttpsError("not-found", "선택한 점검표를 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도해주세요.");
  }

  const total = uniqueIds.length;
  console.log(`${LOG} ${center}: 선택 ${total}건 중 ${targets.length}건 병합 시작`);

  const labelMaps = await loadLabelMaps(center);

  const downloads = await mapWithConcurrency(
    targets,
    EXCEL_MERGE_DOWNLOAD_CONCURRENCY,
    async item => {
      try {
        return { buffer: await downloadSourceBuffer(item) };
      } catch (e) {
        console.warn(`${LOG} 원본 다운로드 실패 (${item.id}):`, e.message);
        return { error: e.message };
      }
    }
  );

  const merged = new ExcelJS.Workbook();
  merged.creator = "M-Event";
  merged.created = new Date();

  const used = new Set();
  const failures = [];
  let strippedImages = 0; // 그림을 들어내야만 읽힌 파일 수 (로고가 빠진 시트)

  // 클라이언트가 보낸 ID 순서 = 화면 목록 순서를 그대로 시트 순서로 유지한다
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    const label = resolveLabel(item, labelMaps);
    const { buffer, error } = downloads[i];

    if (!buffer) {
      failures.push({ label, datetime: item.datetime || "", reason: error || "다운로드 실패" });
      continue;
    }

    try {
      // ⚠️ new Workbook().xlsx.load()를 직접 쓰면 안 된다 — M-Engine은 openpyxl로
      //   파일을 만드는데, 템플릿에 그림이 있으면 ExcelJS가 로드 단계에서 터진다.
      //   loadWorkbookTolerant가 그 경우를 정규화해서 읽어준다 (excel-utils.js 참고).
      const { workbook: srcWb, mode } = await loadWorkbookTolerant(buffer, LOG);
      if (mode === "stripped") strippedImages++;
      const srcSheet = srcWb.worksheets[0]; // M-Engine 산출물은 시트가 1개뿐
      if (!srcSheet) throw new Error("워크시트가 없는 파일");

      cloneSheet(merged, srcSheet, buildSheetName(item, labelMaps, used), {
        sourceWorkbook: srcWb,  // 점검표에 로고 등 이미지가 박혀 있으면 같이 옮김
        copyExtras: true,       // 열 숨김/조건부 서식/데이터 유효성/자동필터까지
        warnPrefix: LOG,
      });
    } catch (e) {
      console.warn(`${LOG} 시트 병합 실패 (${item.id}):`, e.message);
      failures.push({ label, datetime: item.datetime || "", reason: e.message });
    }
  }

  if (merged.worksheets.length === 0) {
    throw new HttpsError("internal", "합칠 수 있는 파일이 없습니다. 잠시 후 다시 시도해주세요.");
  }

  const outBuf = await fixSheetPrOrder(await merged.xlsx.writeBuffer(), LOG);

  // 파일명은 (센터, 조회기간) 조합으로 고정 — 같은 조건으로 다시 병합하면 덮어쓰기 되므로
  // 요청할 때마다 Storage에 파일이 무한정 쌓이지 않는다. start/end는 이름에만 쓰인다
  // (실제로 무엇을 합칠지는 선택된 ids가 결정한다).
  const fileName = `${center}_${start || "전체"}~${end || "전체"}_병합.xlsx`;
  const filePath = `${EXCEL_MERGE_STORAGE_PREFIX}/${center}/${fileName}`;
  await bucket.file(filePath).save(outBuf, { contentType: XLSX_MIME });

  // 서명 URL(10분) — listEventReportFiles와 같은 방식. storage.rules를 열 필요가 없다.
  const [url] = await bucket.file(filePath).getSignedUrl({
    action: "read",
    expires: Date.now() + 10 * 60 * 1000,
  });

  console.log(
    `${LOG} ${filePath} 완료 — 시트 ${merged.worksheets.length}개, ` +
    `실패 ${failures.length}건, 그림 제외 ${strippedImages}건`
  );

  return {
    url,
    fileName,
    total,                                   // 선택한 건수
    merged: merged.worksheets.length,        // 실제로 시트가 된 건수
    missing: total - targets.length,         // 삭제됐거나 센터가 안 맞아 빠진 건수
    maxFiles: EXCEL_MERGE_MAX_FILES,
    strippedImages,                          // 그림 없이 들어간 시트 수 (0이면 전부 온전)
    failures,
  };
});

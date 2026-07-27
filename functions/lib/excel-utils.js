// lib/excel-utils.js
// ExcelJS 공통 유틸 — 워크북 간 시트 복제 + ExcelJS 출력 XML 후처리
//
// 두 함수 모두 원래는 다른 파일 안에 있던 것을 옮겨왔다:
//   cloneSheet      ← worklog-export.js의 cloneTemplateSheet (로직 동일)
//   fixSheetPrOrder ← report-export.js (sheet1.xml 하나만 고치던 것을 전체 시트로 일반화)
// 세 번째 사용처(excel-merge.js — 엑셀 탭 "전체 다운로드")가 생기면서 공유 모듈로 뺐다.
// system_map.md가 반복해서 지적하는 "같은 로직이 두 군데 복제돼 한쪽만 고쳐지는" 패턴을
// 애초에 만들지 않으려는 것.
const ExcelJS = require("exceljs");
const JSZip = require("jszip");

// ==============================================================================
// 워크북 간 시트 복제
// ExcelJS는 워크북 간 시트 이동을 직접 지원하지 않아 셀 단위로 복사한다.
// ==============================================================================

// 시트에 박힌 이미지(로고 등)를 옮긴다.
// 이미지 실제 바이트는 시트가 아니라 워크북(workbook.model.media)에 들어있어서
// srcSheet만으로는 접근할 수 없다 — 그래서 원본 워크북을 따로 받아야 한다.
function copySheetImages(targetWorkbook, ws, sourceWorkbook, srcSheet, warnPrefix) {
  let images = [];
  try {
    images = srcSheet.getImages() || [];
  } catch (e) {
    console.warn(`${warnPrefix} 이미지 목록 조회 실패:`, e.message);
    return;
  }
  if (images.length === 0) return;

  const media = (sourceWorkbook.model && sourceWorkbook.model.media) || [];
  images.forEach(img => {
    const src = media.find(m => String(m.index) === String(img.imageId));
    if (!src || !src.buffer) {
      console.warn(`${warnPrefix} 이미지 원본을 못 찾음 (imageId=${img.imageId})`);
      return;
    }
    try {
      const newId = targetWorkbook.addImage({ buffer: src.buffer, extension: src.extension });
      ws.addImage(newId, img.range);
    } catch (e) {
      console.warn(`${warnPrefix} 이미지 복제 실패:`, e.message);
    }
  });
}

// 조건부 서식 / 데이터 유효성 / 자동필터 — 행·열 구조를 그대로 복제하므로
// 규칙에 박힌 범위 좌표("A1:K10" 등)도 그대로 유효하다.
function copySheetExtras(ws, srcSheet, warnPrefix) {
  try {
    const cf = srcSheet.conditionalFormattings;
    if (Array.isArray(cf) && cf.length > 0) {
      ws.conditionalFormattings = JSON.parse(JSON.stringify(cf));
    }
  } catch (e) {
    console.warn(`${warnPrefix} 조건부 서식 복제 실패:`, e.message);
  }

  try {
    const dv = srcSheet.dataValidations && srcSheet.dataValidations.model;
    if (dv) {
      Object.entries(dv).forEach(([address, rule]) => ws.dataValidations.add(address, rule));
    }
  } catch (e) {
    console.warn(`${warnPrefix} 데이터 유효성 복제 실패:`, e.message);
  }

  try {
    if (srcSheet.autoFilter) ws.autoFilter = srcSheet.autoFilter;
  } catch (e) {
    console.warn(`${warnPrefix} 자동필터 복제 실패:`, e.message);
  }
}

/**
 * srcSheet를 targetWorkbook에 sheetName이라는 새 시트로 복제한다.
 *
 * 기본 복사 범위(열 너비 / 행 높이 / 병합 / 셀 값·서식 / 인쇄 설정)는
 * 근무일지가 쓰던 cloneTemplateSheet와 완전히 동일하다.
 *
 * options.sourceWorkbook — 넘기면 시트 이미지까지 복제 (위 copySheetImages 참고)
 * options.copyExtras     — 열 숨김/열 기본서식, 조건부 서식, 데이터 유효성, 자동필터까지 복제
 *
 * ※ 두 옵션 모두 기본 false. 근무일지(workLogDailyExport)는 이 리팩토링 전과 한 글자도
 *   다르지 않게 동작해야 하므로, 추가된 복사 동작은 전부 호출자가 명시적으로 켤 때만 수행한다.
 */
function cloneSheet(targetWorkbook, srcSheet, sheetName, options = {}) {
  const { sourceWorkbook = null, copyExtras = false, warnPrefix = "[엑셀]" } = options;

  const ws = targetWorkbook.addWorksheet(sheetName, { views: srcSheet.views });

  // 원본에 열 정의가 아예 없는 시트도 있어서(M-Engine 점검표는 센터마다 양식이 다름)
  // 빈 배열을 그대로 대입하지 않도록 방어 — 근무일지 템플릿은 항상 열 정의가 있으므로 동작 동일
  const srcColumns = srcSheet.columns || [];
  if (srcColumns.length > 0) {
    ws.columns = srcColumns.map(col => (
      copyExtras
        ? { width: col && col.width, hidden: col && col.hidden, style: col && col.style }
        : { width: col && col.width }
    ));
  }

  // 인쇄영역/용지방향/배율/여백/맞쪽인쇄 등 페이지 설정 복제
  // (row/column 구조를 그대로 복제하므로 printArea 좌표("A1:N54" 등)도 그대로 유효함)
  if (srcSheet.pageSetup) {
    ws.pageSetup = { ...srcSheet.pageSetup };
  }
  if (srcSheet.headerFooter) {
    ws.headerFooter = { ...srcSheet.headerFooter };
  }

  (srcSheet.model.merges || []).forEach(range => {
    try { ws.mergeCells(range); } catch (e) { console.warn(`${warnPrefix} 병합 복제 실패(${range}):`, e.message); }
  });

  srcSheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const newRow = ws.getRow(rowNumber);
    if (row.height) newRow.height = row.height;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const newCell = newRow.getCell(colNumber);
      newCell.value = cell.value;
      if (cell.style) newCell.style = { ...cell.style };
    });
    newRow.commit();
  });

  if (copyExtras) copySheetExtras(ws, srcSheet, warnPrefix);
  if (sourceWorkbook) copySheetImages(targetWorkbook, ws, sourceWorkbook, srcSheet, warnPrefix);

  return ws;
}

// ==============================================================================
// [ExcelJS 버그 우회] <sheetPr> 자식 태그 순서 교정
//
// ws.pageSetup.fitToPage를 켜면 ExcelJS가 기존 <sheetPr>에 <pageSetUpPr>을 끼워 넣으면서
// <outlinePr>보다 앞에 써버린다. CT_SheetPr는 자식 순서를 엄격히 강제하는 타입이라
// (정상 순서: tabColor → outlinePr → pageSetUpPr) 이 순서 위반만으로 엑셀이 파일을
// 손상됐다고 판단하고 "내용에 문제가 있습니다(복구하시겠습니까?)" 경고를 띄운다.
// ExcelJS 자체 버그라 라이브러리 옵션으로는 못 피하고, 저장된 buffer의 XML을 직접 열어
// 순서를 바로잡은 뒤 다시 압축하는 방식으로 우회한다.
//
// [2026-07-27 일반화] 원래 report-export.js에 있던 버전은 "xl/worksheets/sheet1.xml"
// 하나만 고쳤다. 시트가 1개인 이벤트 보고서에서는 그걸로 충분했지만, 엑셀 탭 통합
// 다운로드는 시트가 수십~100개라 나머지 시트가 전부 안 고쳐진 채 남는다. 그래서
// 워크시트 XML 전체를 돌면서 고치도록 바꿨다.
// ==============================================================================

// <sheetPr> 안의 자식들을 OOXML이 요구하는 순서로 재배치.
// 알 수 없는 자식 태그가 섞여 있으면(스키마 변화 등) 건드리지 않고 원본을 그대로 둔다.
function reorderSheetPrChildren(xml) {
  return xml.replace(/<sheetPr([^>]*)>([\s\S]*?)<\/sheetPr>/g, (whole, attrs, inner) => {
    const pick = tag => {
      const m = new RegExp(`<${tag}\\b[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`).exec(inner);
      return m ? m[0] : "";
    };
    const tabColor = pick("tabColor");
    const outlinePr = pick("outlinePr");
    const pageSetUpPr = pick("pageSetUpPr");

    const ordered = `${tabColor}${outlinePr}${pageSetUpPr}`;
    if (!ordered) return whole;                       // 자식 없음 — 손댈 것 없음

    // 위 셋 말고 다른 게 더 들어있으면 안전하게 원본 유지 (지워버리는 사고 방지)
    const remainder = [tabColor, outlinePr, pageSetUpPr]
      .reduce((acc, tag) => (tag ? acc.replace(tag, "") : acc), inner)
      .trim();
    if (remainder) return whole;

    if (ordered === inner) return whole;              // 이미 순서 정상
    return `<sheetPr${attrs}>${ordered}</sheetPr>`;
  });
}

// ExcelJS가 만든 xlsx 버퍼를 받아 모든 워크시트의 <sheetPr> 순서를 교정한 버퍼를 반환.
// 고칠 게 하나도 없으면 원본 버퍼를 그대로 돌려준다(불필요한 재압축 회피).
async function fixSheetPrOrder(buf, logPrefix = "[엑셀]") {
  const zip = await JSZip.loadAsync(buf);
  const paths = Object.keys(zip.files).filter(p => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));

  let patched = 0;
  for (const path of paths) {
    const xml = await zip.file(path).async("string");
    const fixed = reorderSheetPrChildren(xml);
    if (fixed !== xml) {
      zip.file(path, fixed);
      patched++;
    }
  }

  // 0건이어도 정상일 수 있지만(fitToPage를 안 건드린 시트), 항상 켜는 호출자
  // (report-export.js)에서 0이 찍히면 ExcelJS 출력 형식이 바뀐 신호이므로 로그를 남긴다.
  console.log(`${logPrefix} sheetPr 순서 보정: ${patched}/${paths.length} 시트`);
  if (patched === 0) return buf;

  return zip.generateAsync({ type: "nodebuffer" });
}

// ==============================================================================
// [ExcelJS 한계 우회] openpyxl이 만든 xlsx 읽기
//
// M-Engine은 openpyxl로 점검표를 만든다(M-Engine/excel_writer.py). 그런데 openpyxl은
// 그림(drawing) XML을 기본 네임스페이스로 쓰는 반면
//     <wsDr xmlns="...spreadsheetDrawing"><oneCellAnchor><from>...
// ExcelJS의 파서는 "xdr:" 접두사가 붙은 태그 이름만 인식한다
//     <xdr:wsDr ...><xdr:oneCellAnchor><xdr:from>...
// 둘 다 OOXML 상 유효하지만, ExcelJS는 접두사 없는 쪽을 만나면 drawing 파싱 결과가
// undefined가 되고 곧바로 reconcile 단계에서 터진다:
//     TypeError: Cannot read properties of undefined (reading 'anchors')
//
// ⚠️ 이게 왜 중요하냐면 — 실패하는 게 "이미지 복사"만이 아니라 **파일 로드 자체**다.
//   센터 템플릿(templates/{center}/template.xlsx)에 로고가 하나라도 박혀 있으면
//   그 센터의 점검표는 전부 병합 불가가 된다. 그래서 로드 전에 반드시 손을 봐야 한다.
//
// 대응은 2단계다:
//   1) drawing XML에 xdr: 접두사를 붙여서 정규화 → 이미지까지 살아서 넘어온다
//   2) 그래도 안 되면 그림 관련 파트를 아예 들어내고 로드 → 로고는 잃지만 나머지
//      서식/데이터는 전부 살아남는다 (기능이 통째로 죽는 것보다 낫다)
// ==============================================================================
const XDR_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const DRAWING_XML = /^xl\/drawings\/drawing\d+\.xml$/;

// 접두사 없는 요소 = spreadsheetDrawing 네임스페이스 요소이므로 전부 xdr: 를 붙인다.
// (openpyxl은 drawingml-main은 a:, 관계는 r: 로 이미 접두사를 붙여 쓰기 때문에
//  "접두사 없음 == xdr" 이 성립한다. <?xml?> 선언이나 주석은 정규식에 안 걸린다.)
function addXdrPrefix(xml) {
  if (!/<wsDr[\s>]/.test(xml)) return xml; // 이미 접두사가 붙어있음 — 손댈 필요 없음
  return xml
    .replace(/<(\/?)([A-Za-z_][\w.-]*)([\s/>])/g, (m, slash, tag, tail) =>
      (tag.includes(":") ? m : `<${slash}xdr:${tag}${tail}`))
    .replace(`xmlns="${XDR_NS}"`, `xmlns:xdr="${XDR_NS}"`);
}

// 그림 관련 파트를 전부 들어낸다 (2단계 폴백용).
// 시트 XML의 <drawing r:id="..."/> 참조와 시트 rels의 drawing 관계까지 같이 지워야
// 끊긴 참조가 남지 않는다.
async function stripDrawings(zip) {
  Object.keys(zip.files)
    .filter(p => p.startsWith("xl/drawings/"))
    .forEach(p => zip.remove(p));

  for (const path of Object.keys(zip.files)) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) {
      const xml = await zip.file(path).async("string");
      const fixed = xml.replace(/<drawing\b[^>]*\/>/g, "");
      if (fixed !== xml) zip.file(path, fixed);
    } else if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(path)) {
      const xml = await zip.file(path).async("string");
      const fixed = xml.replace(/<Relationship\b[^>]*\/drawing"[^>]*\/>/g, "")
        .replace(/<Relationship\b(?=[^>]*Target="[^"]*\/drawings\/)[^>]*\/>/g, "");
      if (fixed !== xml) zip.file(path, fixed);
    }
  }
  return zip;
}

/**
 * xlsx 버퍼를 ExcelJS Workbook으로 최대한 관대하게 읽는다.
 * 원본 그대로 → drawing 네임스페이스 정규화 → 그림 제거 순으로 시도한다.
 * 반환: { workbook, mode } — mode는 "raw" | "normalized" | "stripped"
 * 셋 다 실패하면 마지막 에러를 그대로 throw 한다 (호출자가 그 파일만 건너뛸 수 있게).
 */
async function loadWorkbookTolerant(buffer, logPrefix = "[엑셀]") {
  const attempt = async buf => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return wb;
  };

  try {
    return { workbook: await attempt(buffer), mode: "raw" };
  } catch (rawErr) {
    // 1단계: drawing XML 정규화
    try {
      const zip = await JSZip.loadAsync(buffer);
      let touched = false;
      for (const path of Object.keys(zip.files).filter(p => DRAWING_XML.test(p))) {
        const xml = await zip.file(path).async("string");
        const fixed = addXdrPrefix(xml);
        if (fixed !== xml) { zip.file(path, fixed); touched = true; }
      }
      if (touched) {
        const wb = await attempt(await zip.generateAsync({ type: "nodebuffer" }));
        console.log(`${logPrefix} openpyxl drawing 네임스페이스 정규화 후 로드 성공`);
        return { workbook: wb, mode: "normalized" };
      }
    } catch (normErr) {
      console.warn(`${logPrefix} drawing 정규화 실패, 그림 제거로 재시도:`, normErr.message);
    }

    // 2단계: 그림을 들어내고 로드 (로고는 잃지만 서식/데이터는 보존)
    try {
      const zip = await stripDrawings(await JSZip.loadAsync(buffer));
      const wb = await attempt(await zip.generateAsync({ type: "nodebuffer" }));
      console.warn(`${logPrefix} 그림을 제외하고 로드함 — 원본의 이미지는 통합본에 포함되지 않음`);
      return { workbook: wb, mode: "stripped" };
    } catch (stripErr) {
      console.error(`${logPrefix} 그림 제거 후에도 로드 실패:`, stripErr.message);
      throw rawErr;
    }
  }
}

module.exports = { cloneSheet, fixSheetPrOrder, loadWorkbookTolerant };

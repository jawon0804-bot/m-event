// server.js
// Cloud Run에서 실행되는 백엔드 API 서버
// - Firestore 읽기를 이 서버 한 곳으로 집중시켜 클라이언트 직접 호출을 제거
// - center(현장) 단위로 5분 캐시를 두어 동일 데이터 반복 조회를 방지
// - 로그인(이름+전화번호) 인증도 서버에서 처리

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // 프론트(index.html 등) 정적 서빙

// ---------------------------------------------------------------------------
// Firebase Admin 초기화
// Cloud Run 환경에서는 별도 키 파일 없이 서비스 계정(런타임 서비스 ID)으로
// 자동 인증됩니다. 로컬 테스트 시에는 GOOGLE_APPLICATION_CREDENTIALS 환경변수로
// 서비스 계정 키 json 경로를 지정하세요.
// ---------------------------------------------------------------------------
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID || "m-smart-90148",
});
const db = admin.firestore();

// ---------------------------------------------------------------------------
// 엑셀 보고서 단일 컬렉션
// 센터별로 별도 컬렉션을 쓰던 방식(MaxerveUlsan_Excel 등)에서
// Maxerve_Excel 하나로 통합하고 centerName 필드로 필터링합니다.
// 신규 센터 추가 시 코드 수정/재배포 없이 Firestore에 문서만 넣으면 됩니다.
// ---------------------------------------------------------------------------
const EXCEL_COLLECTION = "Maxerve_Excel";

// "Master" 센터로 로그인하면 모든 센터의 데이터를 통합해서 봅니다.
const MASTER_CENTER_NAME = "Master";

// inspection_logs(점검기록)는 최근 60일치만 조회합니다. (엑셀 보고서는 전체 유지)
const INSPECTION_LOGS_LOOKBACK_DAYS = 60;

function getLookbackDateString(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().substring(0, 10); // "YYYY-MM-DD"
}

// URL에서 사람이 읽기 좋은 파일명을 뽑아냅니다.
// Firebase Storage 다운로드 URL은 경로가 %2F로 인코딩되어 있고 쿼리스트링(토큰)이
// 붙어있어서 그대로 쓰면 매우 지저분합니다. 디코딩 + 쿼리 제거 + 마지막 조각만 추출합니다.
// 그래도 알아볼 수 없는 형태(긴 해시/토큰뿐)라면 깔끔한 기본 이름으로 대체합니다.
function extractCleanFileName(url, uploadedAt) {
  try {
    const withoutQuery = url.split("?")[0];
    const decoded = decodeURIComponent(withoutQuery);
    const lastSegment = decoded.split("/").pop();

    // 너무 길거나(40자 이상) 확장자가 없으면 알아보기 힘든 토큰일 가능성이 높음 -> 기본 이름 사용
    const hasReadableExtension = /\.(xlsx|xls|csv|pdf)$/i.test(lastSegment);
    if (lastSegment && lastSegment.length <= 60 && hasReadableExtension) {
      return lastSegment;
    }
  } catch (e) {
    // decodeURIComponent 실패 등 - 아래 기본값으로 폴백
  }
  const dateLabel = uploadedAt ? String(uploadedAt).substring(0, 10) : "";
  return dateLabel ? `보고서_${dateLabel}.xlsx` : "보고서.xlsx";
}

// ---------------------------------------------------------------------------
// 센터(또는 Master)에 해당하는 엑셀 데이터를 Maxerve_Excel 단일 컬렉션에서 조회해
// { excelMap, excelListByFid } 형태로 가공해 반환하는 공통 함수.
// Master면 centerName 필터 없이 전체 조회, 일반 센터면 centerName으로 필터링.
// /api/dashboard와 /api/excel-files(캐시 미스 시) 양쪽에서 재사용합니다.
// ---------------------------------------------------------------------------
async function buildExcelData(center) {
  const excelMap = {};
  const excelListByFid = {};

  const isMaster = center === MASTER_CENTER_NAME;

  // Master는 전체 조회, 일반 센터는 centerName 필터링
  const excelQuery = isMaster
    ? db.collection(EXCEL_COLLECTION)
    : db.collection(EXCEL_COLLECTION).where("center_name", "==", center);

  const excelSnap = await excelQuery.get();

  excelSnap.forEach((doc) => {
    const data = doc.data();
    if (!data.facility_id || !data.file_url) return;

    let fidList = [];
    if (Array.isArray(data.facility_id)) {
      fidList = data.facility_id;
    } else if (typeof data.facility_id === "string") {
      fidList = data.facility_id.split(",").map((s) => s.trim());
    } else {
      fidList = [String(data.facility_id)];
    }
    fidList.sort((a, b) => a.localeCompare(b));

    if (fidList.length === 0) return;

    const primaryFid = fidList[0];
    const uploadedAt =
      data.uploaded_at || data.createdAt || data.datetime || (doc.createTime ? doc.createTime.toDate().toISOString() : "");

    const cleanFid = String(primaryFid).trim();
    if (!excelListByFid[cleanFid]) excelListByFid[cleanFid] = [];
    excelListByFid[cleanFid].push({
      docId: doc.id,
      file_url: data.file_url,
      fileName: data.fileName || data.file_name || extractCleanFileName(data.file_url, uploadedAt),
      uploadedAt,
    });
  });

  // 설비별 최신순 정렬
  Object.keys(excelListByFid).forEach((fid) => {
    excelListByFid[fid].sort((a, b) => {
      const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return tb - ta;
    });
  });

  // excelMap: 정렬 완료된 첫 번째 항목(최신)으로 구성
  Object.keys(excelListByFid).forEach((fid) => {
    excelMap[fid] = excelListByFid[fid][0].file_url;
  });

  return { excelMap, excelListByFid };
}

// ---------------------------------------------------------------------------
// 메모리 캐시 (인스턴스 단위, 5분 TTL)
// Cloud Run은 인스턴스가 여러 개 뜰 수 있어 완전한 전역 캐시는 아니지만,
// 최소 동시성(min-instances=1) 또는 단일 인스턴스 운영 시 읽기량이 크게 줄어듭니다.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분
const cache = new Map(); // key -> { data, expiresAt }

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCache(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// 설비ID -> 위치명 매핑 (center_configs/{center}/facilities 에서 동적으로 조회)
// 센터별 서브컬렉션: center_configs/{center}/facilities/{fid}
//   fid_name: 위치명, category: 카테고리, center_name: 센터명
// 결과는 메모리에 캐시 (CACHE_TTL_MS 동일 적용)
// ---------------------------------------------------------------------------
async function getFidLocations(center) {
  const cacheKey = `fidLocations:${center}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const locations = {};
  try {
    const isMaster = center === MASTER_CENTER_NAME;

    if (isMaster) {
      // Master: center_configs 전체 센터 서브컬렉션 병렬 조회
      const centersSnap = await db.collection("center_configs").get();
      await Promise.all(centersSnap.docs.map(async (centerDoc) => {
        const snap = await centerDoc.ref.collection("facilities").get();
        snap.forEach((doc) => {
          locations[doc.id] = doc.data().fid_name || doc.id;
        });
      }));
    } else {
      const snap = await db
        .collection("center_configs")
        .doc(center)
        .collection("facilities")
        .get();
      snap.forEach((doc) => {
        locations[doc.id] = doc.data().fid_name || doc.id;
      });
    }
  } catch (e) {
    console.error("center_configs/facilities 조회 오류:", e);
  }

  setCache(cacheKey, locations);
  return locations;
}

// ---------------------------------------------------------------------------
// POST /api/login
// 기존 클라이언트의 UserDB 조회(이름+전화번호) 로직을 서버로 이전
// ---------------------------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    if (!name || !phone) {
      return res.status(400).json({ ok: false, message: "이름과 전화번호를 모두 입력해주세요." });
    }

    const snapshot = await db
      .collection("UserDB")
      .where("name", "==", name)
      .where("phone", "==", phone)
      .get();

    if (snapshot.empty) {
      return res.status(401).json({ ok: false, message: "인증 실패: 등록되지 않은 사용자이거나 정보가 일치하지 않습니다." });
    }

    const userData = snapshot.docs[0].data();

    // active 필드가 명시적으로 true인 계정만 로그인 허용
    // false이거나 필드가 없으면 차단 (Firebase 콘솔에서 active: true/false로 관리)
    if (userData.active !== true) {
      return res.status(403).json({ ok: false, message: "접근이 제한된 계정입니다. 관리자에게 문의하세요." });
    }

    return res.json({ ok: true, center: userData.center_name || "" });
  } catch (err) {
    console.error("로그인 처리 오류:", err);
    return res.status(500).json({ ok: false, message: "서버 연결에 문제가 발생했습니다." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard?center=XXX
// 기존 loadDashboardData()의 Firestore 조회 + 가공 로직을 서버로 이전
// center 단위로 5분 캐시 적용 → 동일 현장에서 새로고침을 반복해도
// Firestore 실제 읽기는 5분에 한 번만 발생
// ---------------------------------------------------------------------------
app.get("/api/dashboard", async (req, res) => {
  try {
    const center = (req.query.center || "").toString().trim();
    if (!center) {
      return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });
    }

    const cacheKey = `dashboard:${center}`;
    const cached = getCache(cacheKey);
    if (cached) {
      return res.json({ ok: true, cached: true, ...cached });
    }

    const isMaster = center === MASTER_CENTER_NAME;
    const lookbackDate = getLookbackDateString(INSPECTION_LOGS_LOOKBACK_DAYS);

    // inspection_logs: 최근 60일치만 조회 (datetime은 ISO 문자열이라 사전식 비교 = 시간순 비교와 동일)
    // Master는 centerName 필터 없이 전체 센터를 60일 리밋만 걸어서 조회
    const logsQuery = isMaster
      ? db.collection("inspection_logs").where("datetime", ">=", lookbackDate)
      : db.collection("inspection_logs").where("center_name", "==", center).where("datetime", ">=", lookbackDate);

    // 엑셀 보고서: 리밋 없이 전체. Master는 등록된 모든 센터 컬렉션을 병렬 조회 후 합산
    const [logsSnap, { excelMap, excelListByFid }, fidLocations] = await Promise.all([
      logsQuery.get(),
      buildExcelData(center),
      getFidLocations(center),
    ]);

    // 점검 기록 가공
    const records = [];
    logsSnap.forEach((doc) => {
      const data = doc.data();
      const fids = Array.isArray(data.facility_id) ? data.facility_id : [data.facility_id || "알수없음"];

      const firstFid = fids[0] ? String(fids[0]).trim() : "";
      const linkForThisRecord = excelMap[firstFid] || "";

      fids.forEach((fid, index) => {
        const cleanFid = fid ? String(fid).trim() : "알수없음";
        records.push({
          date: data.datetime ? data.datetime.substring(0, 10) : "",
          inspector: data.worker || "미지정",
          fid: cleanFid,
          file_url: index === 0 ? linkForThisRecord : "",
        });
      });
    });

    const excelCountByFid = {};
    Object.keys(excelListByFid).forEach((fid) => {
      excelCountByFid[fid] = excelListByFid[fid].length;
    });

    const payload = {
      center,
      records,
      excelMap,
      excelCountByFid,
      fidLocations,
      generatedAt: new Date().toISOString(),
    };

    setCache(cacheKey, payload);
    // 설비별 엑셀 전체 목록은 /api/excel-files 페이지네이션 조회에서 재사용하도록
    // 별도 캐시 키로도 저장해둡니다 (동일 5분 TTL).
    setCache(`excelList:${center}`, excelListByFid);

    return res.json({ ok: true, cached: false, ...payload });
  } catch (err) {
    console.error("대시보드 데이터 조회 오류:", err);
    return res.status(500).json({ ok: false, message: "데이터 조회 중 오류가 발생했습니다." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/excel-files?center=XXX&fid=기계_01&page=1&pageSize=15
// - fid가 있으면: 해당 설비ID의 엑셀 보고서 전체 목록을 최신순으로 반환
// - fid가 없으면: 센터(또는 Master)의 "모든" 설비 엑셀 보고서를 합쳐 최신순으로 반환
//   (3번 뷰 헤더 "보고서" 클릭 시 사용 — 전체 설비 통합 목록)
// /api/dashboard와 동일한 5분 캐시(excelList:{center})를 재사용하므로
// 팝업을 여러 번 열어도 Firestore 추가 읽기가 거의 발생하지 않습니다.
// ---------------------------------------------------------------------------
app.get("/api/excel-files", async (req, res) => {
  try {
    const center = (req.query.center || "").toString().trim();
    const fid = (req.query.fid || "").toString().trim(); // 비어있으면 "전체" 모드
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

    if (!center) {
      return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });
    }

    const listCacheKey = `excelList:${center}`;
    let excelListByFid = getCache(listCacheKey);

    if (!excelListByFid) {
      // 캐시가 없으면(만료 또는 /api/dashboard를 아직 호출 안 한 경우) 직접 조회
      const built = await buildExcelData(center);
      excelListByFid = built.excelListByFid;
      setCache(listCacheKey, excelListByFid);
    }

    let fullList;
    if (fid) {
      // 특정 설비ID 모드: 항목에 fid를 별도로 붙이지 않아도 이미 알고 있음
      fullList = (excelListByFid[fid] || []).map((item) => ({ ...item, fid }));
    } else {
      // 전체 모드: 모든 설비ID의 파일을 합쳐서 최신순 재정렬
      fullList = [];
      Object.keys(excelListByFid).forEach((f) => {
        excelListByFid[f].forEach((item) => fullList.push({ ...item, fid: f }));
      });
      fullList.sort((a, b) => {
        const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
        const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
        return tb - ta;
      });
    }

    const totalCount = fullList.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    const items = fullList.slice(start, start + pageSize);

    return res.json({
      ok: true,
      fid: fid || null,
      page: safePage,
      pageSize,
      totalCount,
      totalPages,
      items,
    });
  } catch (err) {
    console.error("엑셀 파일 목록 조회 오류:", err);
    return res.status(500).json({ ok: false, message: "엑셀 파일 목록 조회 중 오류가 발생했습니다." });
  }
});

// 캐시 강제 무효화 (관리/디버깅용 - 필요시 버튼에 연결 가능)
app.post("/api/dashboard/refresh", (req, res) => {
  const center = (req.query.center || "").toString().trim();
  if (center) {
    cache.delete(`dashboard:${center}`);
    cache.delete(`excelList:${center}`);
  } else {
    cache.clear();
  }
  res.json({ ok: true });
});

// ── /api/fidlocations ──────────────────────────────────────────
// fid → fid_name 매핑 반환 (m-event 이벤트트래커에서 사용)
app.get("/api/fidlocations", async (req, res) => {
  const center = (req.query.center || "").toString().trim();
  if (!center) return res.status(400).json({ ok: false, message: "center 파라미터가 필요합니다." });
  try {
    const locations = await getFidLocations(center);
    return res.json({ ok: true, fidLocations: locations });
  } catch(e) {
    console.error("fidlocations 오류:", e);
    return res.status(500).json({ ok: false, message: "조회 중 오류가 발생했습니다." });
  }
});

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});

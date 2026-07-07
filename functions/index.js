/**
 * Firebase Functions - M-Event 이슈 트래커 + 근무일지
 *
 * [트리거 1] inspection_logs 문서 생성/수정 시 memo 필드 감지
 *          → events 컬렉션에 이벤트 생성
 *          → 해당 센터 관리자에게 이메일 발송
 * [트리거 2] events 문서 상태 변경 시 관리자 이메일 발송
 * [스케줄 1] 매일 09:00 — 3일 이상 미조치 이벤트 재알림
 * [스케줄 2] 매일 09:00 — 근무일지(work_logs) Firestore 데이터를
 *            센터별 월별 엑셀 파일(Storage)의 "N일" 탭으로 변환
 *
 * [2nd Gen 전환 안내]
 *   2026-07-06부로 firebase-functions/v2 기준으로 전환.
 *   - functions.config() 제거 → Secret Manager(defineSecret)로 GMAIL_USER/GMAIL_PASS 관리
 *   - 트리거는 onDocumentWritten/onDocumentUpdated(Firestore), onSchedule(스케줄러) 사용
 *   - 콜백 시그니처는 (event) 형태, event.data.before/after, event.params 사용
 *   - region은 setGlobalOptions로 전역 설정 (asia-northeast3 유지)
 *
 * [배포] 반드시 함수명을 지정할 것. 전체 배포(--only functions) 절대 금지.
 *   이 프로젝트(m-smart-90148)에는 M-Event 외 별도 모니터링 함수
 *   (collectMetrics, getDashboardData, region: us-central1)가 같이 배포되어 있어
 *   전체 배포 시 그 함수들이 삭제 후보로 잡힐 수 있음.
 *
 *   firebase deploy --only functions:onInspectionLog,functions:onIssueUpdate,functions:issueReminderScheduler,functions:workLogDailyExport
 *
 * [사전 준비]
 *   npm install firebase-functions@latest firebase-admin@^13.0.0 exceljs --save
 *   firebase functions:secrets:set GMAIL_USER
 *   firebase functions:secrets:set GMAIL_PASS
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

// region 전역 설정 (asia-northeast3 유지 — 모니터링 함수는 us-central1이라 서로 안 겹침)
setGlobalOptions({ region: "asia-northeast3" });

// Gmail 인증 정보 — Secret Manager로만 관리 (코드에 하드코딩 금지)
const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_PASS = defineSecret("GMAIL_PASS");

// ==============================================================================
// [유틸] Gmail 인증 정보
// ==============================================================================
function getGmailAuth() {
  return {
    user: GMAIL_USER.value(),
    pass: GMAIL_PASS.value(),
  };
}

// Gmail SMTP 설정
const getTransporter = () => {
  const auth = getGmailAuth();
  return nodemailer.createTransport({ service: "gmail", auth });
};

// ==============================================================================
// [유틸] HTML 이스케이프 (이메일 본문 인젝션 방지)
// ==============================================================================
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 개행 → <br> (이스케이프 후 변환)
function nl2br(s) {
  return escHtml(s).replace(/\n/g, "<br>");
}

// ==============================================================================
// [유틸] 센터 관리자 이메일 목록 조회
// ==============================================================================
async function getAdminEmails(center_name) {
  try {
    const snap = await db.collection("UserDB")
      .where("center_name", "==", center_name)
      .where("active", "==", true)
      .get();
    return snap.docs
      .map(d => d.data().email)
      .filter(Boolean);
  } catch (e) {
    console.error("관리자 이메일 조회 실패:", e);
    return [];
  }
}

// ==============================================================================
// [유틸] 이메일 발송
// 발송 성공 여부(boolean)를 반환한다.
// 실패해도 throw하지 않으므로 트리거 흐름을 막지 않는다. (기존 패턴 유지)
// ==============================================================================
async function sendMail(to, subject, html) {
  if (!to || to.length === 0) {
    console.warn("수신자 없음, 메일 발송 스킵");
    return false;
  }
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"M-Event 알림" <${getGmailAuth().user}>`,
      to: Array.isArray(to) ? to.join(", ") : to,
      subject,
      html,
    });
    console.log("메일 발송 완료:", subject, "→", to);
    return true;
  } catch (e) {
    console.error("메일 발송 실패:", e);
    return false;
  }
}

// ==============================================================================
// [유틸] 이메일 HTML 템플릿
// 모든 삽입값은 escHtml/nl2br로 이스케이프한다.
// ==============================================================================
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
// memo 필드가 있으면 → events 컬렉션에 이벤트 생성 + 관리자 메일
//
// [중복 방지 전략]
//   이벤트 문서 ID를 `log_{logDocId}` 로 결정적으로 생성한다.
//   → 동일 로그에 대해 트리거가 동시에/재시도로 여러 번 실행돼도
//     같은 문서를 가리키므로 race condition에 의한 중복 생성이 불가능하다.
//   기존(랜덤 ID) 이벤트와의 호환을 위해 source_log_id 조회를 폴백으로 유지한다.
// ==============================================================================
exports.onInspectionLog = onDocumentWritten(
  { document: "inspection_logs/{docId}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async (event) => {
    const after  = event.data.after && event.data.after.exists  ? event.data.after.data()  : null;
    const before = event.data.before && event.data.before.exists ? event.data.before.data() : null;

    // 삭제된 경우 스킵
    if (!after) return;

    const memo = (after.memo || "").trim();
    if (!memo) return;

    // memo가 새로 생기거나 변경된 경우만 처리
    const prevMemo = (before?.memo || "").trim();
    if (memo === prevMemo) return;

    const center_name = after.center_name || "";
    const facility_id = after.facility_id || "";
    const worker      = after.worker      || "";
    const datetime    = after.datetime    || "";
    const photos      = after.photos      || "";
    const logDocId    = event.params.docId;

    // facility_info에서 fid_name 조회 (facility_id가 여러 개일 경우 첫 번째 값으로 조회)
    let fid_name = facility_id;
    try {
      const firstFid = (facility_id || "").split(",")[0].trim();
      if (firstFid) {
        const facDoc = await db.collection("center_configs")
          .doc(center_name).collection("facilities").doc(firstFid).get();
        if (facDoc.exists) fid_name = facDoc.data().fid_name || facility_id;
      }
    } catch (e) { console.warn("fid_name 조회 실패:", e); }

    console.log(`[이슈 생성] ${center_name} / ${facility_id} / memo: ${memo}`);

    // 1) 결정적 ID로 조회 (신규 방식)
    const eventRef = db.collection("events").doc(`log_${logDocId}`);
    const eventDoc = await eventRef.get();

    if (eventDoc.exists) {
      await eventRef.update({
        memo,
        photos,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("[이슈 업데이트] 기존 이슈 memo 수정:", eventRef.id);
      return;
    }

    // 2) 레거시(랜덤 ID) 이벤트 조회 폴백 — 과거 생성분 중복 방지
    const legacy = await db.collection("events")
      .where("source_log_id", "==", logDocId)
      .limit(1)
      .get();

    if (!legacy.empty) {
      await legacy.docs[0].ref.update({
        memo,
        photos,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("[이슈 업데이트] 레거시 이슈 memo 수정:", legacy.docs[0].id);
      return;
    }

    // 3) 새 이슈 생성 (결정적 ID)
    await eventRef.set({
      // 기본 정보
      center_name:    center_name,
      facility_id:    facility_id,
      fid_name:       fid_name,
      worker:         worker,
      memo:           memo,
      datetime:       datetime,
      photos:         photos,
      source_log_id:  logDocId,

      // 상태
      status:         "발생",   // 발생 / 조치중 / 완료

      // 타임라인 이력
      history: [{
        type:       "발생",
        content:    memo,
        by:         worker,
        at:         admin.firestore.Timestamp.now(),
      }],

      // 알림 추적 (3일 경과 체크용)
      last_notified_at: admin.firestore.Timestamp.now(),
      notified_count:   0,

      // 메타
      created_at:   admin.firestore.FieldValue.serverTimestamp(),
      updated_at:   admin.firestore.FieldValue.serverTimestamp(),
      completed_at: null,
    });

    console.log("[이슈 생성 완료]", eventRef.id);

    // 관리자 메일 발송
    const adminEmails = await getAdminEmails(center_name);
    const eventUrl = `https://m-smart-0804.web.app/index.html?id=${eventRef.id}`;

    await sendMail(
      adminEmails,
      `[이벤트 발생] ${center_name} - ${facility_id} - ${memo}`,
      makeEmailHtml({
        title:      "🔴 새 이벤트가 등록되었습니다",
        center_name: center_name, facility_id: facility_id, fid_name: fid_name, worker, datetime,
        memo,
        actionUrl:  eventUrl,
      })
    );
  }
);


// ==============================================================================
// [트리거 2] events 문서 수정 감지 (2nd Gen: onDocumentUpdated)
// 조치/완료 상태 변경 시 관리자 메일 발송
// ==============================================================================
exports.onIssueUpdate = onDocumentUpdated(
  { document: "events/{eventId}", secrets: [GMAIL_USER, GMAIL_PASS] },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    // 상태 변경 없으면 스킵
    if (before.status === after.status) return;

    const center_name = after.center_name || "";
    const facility_id = after.facility_id || "";
    const memo       = after.memo         || "";
    const datetime   = after.datetime     || "";
    const eventId    = event.params.eventId;
    const eventUrl   = `https://m-smart-0804.web.app/index.html?id=${eventId}`;

    const adminEmails = await getAdminEmails(center_name);

    // 마지막 이력 항목 (방금 추가된 조치/완료 내용)
    const lastHistory = (after.history || []).slice(-1)[0] || {};

    if (after.status === "조치중") {
      await sendMail(
        adminEmails,
        `[조치 진행] ${center_name} - ${facility_id} - ${memo}`,
        makeEmailHtml({
          title:      "🟡 이벤트 조치가 시작되었습니다",
          center_name: center_name, facility_id: facility_id,
          worker:     lastHistory.by  || "",
          datetime,
          memo:       lastHistory.content || "",
          actionUrl:  eventUrl,
        })
      );
    } else if (after.status === "완료") {
      await sendMail(
        adminEmails,
        `[이벤트 완료] ${center_name} - ${facility_id} - ${memo}`,
        makeEmailHtml({
          title:      "🟢 이벤트가 완료 처리되었습니다",
          center_name: center_name, facility_id: facility_id,
          worker:     lastHistory.by  || "",
          datetime,
          memo:       lastHistory.content || "",
          actionUrl:  eventUrl,
        })
      );
    }
  }
);


// ==============================================================================
// [스케줄 1] 3일 경과 이슈 알림 (매일 09:00, 2nd Gen: onSchedule)
// 완료되지 않은 이슈 중 last_notified_at이 3일 이상 지난 것들에 재알림
//
// [쿼리 수정 이유]
//   기존: .where("status","!=","완료") + .where("last_notified_at","<=",threshold)
//   → Firestore는 서로 다른 두 필드에 부등식 필터를 동시에 걸 수 없어
//     런타임 INVALID_ARGUMENT 에러 발생 (기능 자체가 동작하지 않음).
//   수정: status는 동등 계열 필터인 "in"으로 변경 → 부등식이 1개만 남아 정상 동작.
//   ※ status + last_notified_at 복합 색인 필요 시 에러 로그의 링크로 생성.
//
// [메일 실패 처리]
//   sendMail이 실패(false)하면 last_notified_at을 갱신하지 않아
//   다음 실행 시 재시도된다. (기존에는 실패해도 갱신되어 3일간 알림 누락)
// ==============================================================================
exports.issueReminderScheduler = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Seoul", secrets: [GMAIL_USER, GMAIL_PASS] },
  async () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const threshold = admin.firestore.Timestamp.fromDate(threeDaysAgo);

    // 완료되지 않고 3일 이상 알림이 없는 이슈 조회
    const snap = await db.collection("events")
      .where("status", "in", ["발생", "조치중"])
      .where("last_notified_at", "<=", threshold)
      .get();

    console.log(`[3일 알림] 대상 이슈: ${snap.size}건`);

    let sent = 0;

    for (const doc of snap.docs) {
      const issue       = doc.data();
      const center_name = issue.center_name || "";
      const facility_id = issue.facility_id || "";
      const memo        = issue.memo        || "";
      const status      = issue.status      || "";
      const count       = (issue.notified_count || 0) + 1;
      const eventUrl    = `https://m-smart-0804.web.app/index.html?id=${doc.id}`;

      const adminEmails = await getAdminEmails(center_name);

      const ok = await sendMail(
        adminEmails,
        `[${count}차 미조치 알림] ${center_name} - ${facility_id} - ${memo}`,
        makeEmailHtml({
          title:      `⚠️ 미처리 이벤트 ${count}차 알림 (현재 상태: ${status})`,
          center_name: center_name, facility_id: facility_id,
          worker:     issue.worker   || "",
          datetime:   issue.datetime || "",
          memo:       `${memo}\n\n※ 이 이슈는 3일 이상 처리되지 않아 재알림이 발송됩니다.`,
          actionUrl:  eventUrl,
        })
      );

      // 발송 성공한 건만 last_notified_at 갱신
      // (batch 대신 개별 update: 500건 제한 회피 + 실패 건 선별 갱신)
      if (ok) {
        await doc.ref.update({
          last_notified_at: admin.firestore.Timestamp.now(),
          notified_count:   count,
        });
        sent++;
      }
    }

    console.log(`[3일 알림] 완료: 대상 ${snap.size}건 중 ${sent}건 발송/갱신`);
  }
);


/**
 * ==============================================================================
 * [근무일지] Firestore → 월별 엑셀(Storage) 변환 스케줄러
 * ==============================================================================
 *
 * [설계 요약]
 *   - 근무 중(09:00~다음날 09:00)에는 Firestore에만 저장한다 (프런트엔드가 담당).
 *     동시 저장 안전성을 위해 줄 단위 데이터는 서브컬렉션(append-only)으로 관리한다.
 *   - 매일 09:00에 이 스케줄러가 "어제 근무일" 데이터를 통째로 읽어서
 *     센터별 월별 엑셀 파일(Storage)의 "그 날짜" 탭으로 굽는다.
 *   - 엑셀 파일은 Firestore의 파생 결과물이며, 소스는 항상 Firestore다.
 *     (여러 사람이 동시에 엑셀 파일에 직접 쓰면 마지막 쓰기가 이전 내용을 덮어써
 *      데이터가 유실될 수 있어 이 방식을 피한다 — Storage는 부분 업데이트/트랜잭션이 없음)
 *
 * [Firestore 스키마]
 *   work_logs/{center}_{workday}                 (workday = "YYYY-MM-DD", 09:00 기준 근무일)
 *     ├─ (문서 필드) sig_staff, sig_manager, sig_teamlead, date_input, weather_input,
 *     │              cnt_*, names_*, util_* 등 단일값 필드
 *     ├─ dayWork/{entryId}    { content, created_by, created_at, edited_by, edited_at }
 *     ├─ dayCheck/{entryId}   동일 구조
 *     ├─ nightWork/{entryId}  동일 구조
 *     ├─ nightNote/{entryId}  동일 구조
 *     ├─ legal/{entryId}      { sched, company, contact, content, created_by, ... }
 *     └─ material/{entryId}   { workno, partno, qty, unit, usage, date, stock, ... }
 *
 * [저장 경로] work_log/{center}/{yyyy}년_{M}월_점검표.xlsx, 시트명 "{d}일"
 *
 * [TODO — 다음 단계]
 *   1) 출근부 자동 로딩: 매일 09:00에 오늘자 work_logs 문서를 새로 시작할 때
 *      headcount/근무자 명단을 출근부(위치 미정)에서 읽어와 초기값으로 채워넣기.
 *   2) Firestore 보안 규칙: "직원 누구나 자기 줄 저장 가능(수정은 본인/관리자만)"을
 *      실제로 강제하려면 firestore.rules에 반영 필요 (현재 프로젝트에 rules 파일 없음).
 * ==============================================================================
 */

// 원본 양식(쿠팡 울산sub-hub 물류센터 시설 업무일지)에서 추출한 라벨/병합/좌표 데이터
const WORKLOG_LAYOUT = {"labels": {"2_2": "쿠팡 울산sub-hub 물류센터 시설 업무일지", "2_12": "담  당", "2_13": "과  장", "2_14": "팀  장", "5_4": "날 씨 :", "6_2": "인 력 현 황", "6_3": "총 원", "6_5": "출 근 자", "6_7": "주 간", "6_8": "야 간", "6_9": "비 번", "6_10": "휴 무", "6_11": "연 차", "6_12": "대휴", "6_13": "교육", "6_14": "병가", "8_3": "주간 근무자", "8_7": "야간 근무자", "8_11": "비번/휴무/교육", "11_2": "유틸리티 지침 현황", "13_2": "구  분", "13_6": "단 위", "13_8": "전일 지침", "13_10": "금일 지침", "13_12": "금일사용량", "13_13": "일간누적량", "13_14": "월간사용량", "14_2": "상수도", "14_6": "㎥", "15_2": "합    계  ( kW )", "17_2": "법정점검 및 대관업무, 공사관련", "18_2": "구분", "18_3": "일정", "18_5": "업체명", "18_7": "담당자(연락처)", "18_9": "업무(공사)내용", "19_2": "1", "20_2": "2", "21_2": "3", "22_2": "4", "23_2": "5", "24_2": "구분", "24_3": "주 간 업 무", "24_13": "일 상 점 검", "26_2": "업 무 내 용", "26_3": "작업내용", "36_3": "야 간 업 무", "36_13": "특 이 사 항", "38_3": "작업내용", "48_3": "자재 입출고 내역", "49_3": "작업번호", "49_4": "PART NO.", "49_8": "수량", "49_9": "단위", "49_10": "사용 내용", "49_13": "사용날짜", "49_14": "재고"}, "merges": [[1, 2, 1, 14], [2, 2, 3, 10], [3, 12, 4, 12], [3, 13, 4, 13], [3, 14, 4, 14], [4, 2, 4, 10], [5, 2, 5, 3], [5, 5, 5, 13], [6, 2, 9, 2], [6, 3, 6, 4], [6, 5, 6, 6], [7, 3, 7, 4], [7, 5, 7, 6], [8, 3, 8, 6], [8, 7, 8, 10], [8, 11, 8, 14], [9, 3, 9, 6], [9, 7, 9, 10], [9, 11, 9, 14], [10, 2, 10, 14], [11, 2, 11, 14], [12, 2, 12, 14], [13, 2, 13, 5], [13, 6, 13, 7], [13, 8, 13, 9], [13, 10, 13, 11], [14, 3, 14, 5], [14, 6, 14, 7], [14, 8, 14, 9], [14, 10, 14, 11], [15, 2, 15, 11], [16, 2, 16, 14], [17, 2, 17, 14], [18, 3, 18, 4], [18, 5, 18, 6], [18, 7, 18, 8], [18, 9, 18, 14], [19, 3, 19, 4], [19, 5, 19, 6], [19, 7, 19, 8], [19, 9, 19, 14], [20, 3, 20, 4], [20, 5, 20, 6], [20, 7, 20, 8], [20, 9, 20, 14], [21, 3, 21, 4], [21, 5, 21, 6], [21, 7, 21, 8], [21, 9, 21, 14], [22, 3, 22, 4], [22, 5, 22, 6], [22, 7, 22, 8], [22, 9, 22, 14], [23, 3, 23, 4], [23, 5, 23, 6], [23, 7, 23, 8], [23, 9, 23, 14], [24, 2, 25, 2], [24, 3, 25, 12], [24, 13, 25, 14], [26, 2, 54, 2], [26, 3, 35, 3], [26, 4, 26, 12], [26, 13, 26, 14], [27, 4, 27, 12], [27, 13, 27, 14], [28, 4, 28, 12], [28, 13, 28, 14], [29, 4, 29, 12], [29, 13, 29, 14], [30, 4, 30, 12], [30, 13, 30, 14], [31, 4, 31, 12], [31, 13, 31, 14], [32, 4, 32, 12], [32, 13, 32, 14], [33, 4, 33, 12], [33, 13, 33, 14], [34, 4, 34, 12], [34, 13, 34, 14], [35, 4, 35, 12], [35, 13, 35, 14], [36, 3, 37, 12], [36, 13, 37, 14], [38, 3, 47, 3], [38, 4, 38, 12], [38, 13, 38, 14], [39, 4, 39, 12], [39, 13, 39, 14], [40, 4, 40, 12], [40, 13, 40, 14], [41, 4, 41, 12], [41, 13, 41, 14], [42, 4, 42, 12], [42, 13, 42, 14], [43, 4, 43, 12], [43, 13, 43, 14], [44, 4, 44, 12], [44, 13, 44, 14], [45, 4, 45, 12], [45, 13, 45, 14], [46, 4, 46, 12], [46, 13, 46, 14], [47, 4, 47, 12], [47, 13, 47, 14], [48, 3, 48, 14], [49, 4, 49, 7], [49, 10, 49, 12], [50, 4, 50, 7], [50, 10, 50, 12], [51, 4, 51, 7], [51, 10, 51, 12], [52, 4, 52, 7], [52, 10, 52, 12], [53, 4, 53, 7], [53, 10, 53, 12], [54, 4, 54, 7], [54, 10, 54, 12]], "singleFields": {"sig_staff": [3, 12], "sig_manager": [3, 13], "sig_teamlead": [3, 14], "date_input": [5, 2], "weather_input": [5, 5], "cnt_total": [7, 3], "cnt_attend": [7, 5], "cnt_day": [7, 7], "cnt_night": [7, 8], "cnt_off": [7, 9], "cnt_rest": [7, 10], "cnt_annual": [7, 11], "cnt_compoff": [7, 12], "cnt_edu": [7, 13], "cnt_sick": [7, 14], "names_day": [9, 3], "names_night": [9, 7], "names_off": [9, 11], "util_water_name": [14, 3], "util_water_prev": [14, 8], "util_water_today": [14, 10], "util_water_usage": [14, 12], "util_water_cum": [14, 13], "util_water_month": [14, 14], "util_kw_usage": [15, 12], "util_kw_cum": [15, 13], "util_kw_month": [15, 14]}, "sections": {"legal": {"startRow": 19, "rows": 5, "cols": {"sched": 3, "company": 5, "contact": 7, "content": 9}}, "dayWork": {"startRow": 26, "rows": 10, "col": 4}, "dayCheck": {"startRow": 26, "rows": 10, "col": 13}, "nightWork": {"startRow": 38, "rows": 10, "col": 4}, "nightNote": {"startRow": 38, "rows": 10, "col": 13}, "material": {"startRow": 50, "rows": 5, "cols": {"workno": 3, "partno": 4, "qty": 8, "unit": 9, "usage": 10, "date": 13, "stock": 14}}}, "maxRow": 54, "maxCol": 14};

// ──────────────────────────────────────────────
// [유틸] 09:00 기준 근무일(workday) 계산
//   09:00 이전 시각이면 "전날"로 취급 (주간+야간 근무를 같은 근무일로 묶기 위함)
// ──────────────────────────────────────────────
function getWorkday(d) {
  const kst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  if (kst.getHours() < 9) kst.setDate(kst.getDate() - 1);
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, "0");
  const day = String(kst.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ──────────────────────────────────────────────
// [유틸] 특정 센터/근무일의 Firestore 문서 + 모든 서브컬렉션을 한 번에 읽어온다
// ──────────────────────────────────────────────
async function loadWorkLogData(center, workday) {
  const docId = `${center}_${workday}`;
  const ref = db.collection("work_logs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return null; // 그날 아무도 작성 안 했으면 스킵

  const base = snap.data();
  const subNames = ["dayWork", "dayCheck", "nightWork", "nightNote", "legal", "material"];
  const data = { ...base };
  for (const name of subNames) {
    const subSnap = await ref.collection(name).orderBy("created_at", "asc").get();
    data[name] = subSnap.docs.map((d) => d.data());
  }
  return data;
}

// ──────────────────────────────────────────────
// [유틸] 워크북에서 "N일" 시트를 새로 만들거나 기존 것을 지우고 재생성
// ──────────────────────────────────────────────
function resetSheet(workbook, sheetName) {
  const existing = workbook.getWorksheet(sheetName);
  if (existing) workbook.removeWorksheet(existing.id);
  return workbook.addWorksheet(sheetName);
}

// ──────────────────────────────────────────────
// [핵심] Firestore 데이터를 시트에 라벨+병합+값으로 채워넣는다
// ──────────────────────────────────────────────
function fillWorkLogSheet(ws, data) {
  // 1) 고정 라벨(원본 양식의 텍스트) 기록
  for (const key of Object.keys(WORKLOG_LAYOUT.labels)) {
    const [r, c] = key.split("_").map(Number);
    ws.getCell(r, c).value = WORKLOG_LAYOUT.labels[key];
  }

  // 2) 병합 적용
  for (const [r1, c1, r2, c2] of WORKLOG_LAYOUT.merges) {
    try {
      ws.mergeCells(r1, c1, r2, c2);
    } catch (e) {
      console.warn("[근무일지] 병합 실패(무시하고 계속):", r1, c1, r2, c2, e.message);
    }
  }

  // 3) 단일값 필드(서명/날씨/인원수 등) 기록
  for (const [fid, [r, c]] of Object.entries(WORKLOG_LAYOUT.singleFields)) {
    if (data[fid] !== undefined && data[fid] !== "") {
      ws.getCell(r, c).value = data[fid];
    }
  }

  // 4) 줄 단위(작업내용) 섹션 기록 — 단일 content 필드
  function fillSimpleSection(sectionKey, arr) {
    const sec = WORKLOG_LAYOUT.sections[sectionKey];
    (arr || []).forEach((item, i) => {
      const r = sec.startRow + i;
      if (i >= sec.rows) {
        console.warn(`[근무일지] ${sectionKey} 항목이 템플릿 행수(${sec.rows})를 초과 — ${r}행에 추가 기록`);
      }
      ws.getCell(r, sec.col).value = item.content || "";
    });
  }
  fillSimpleSection("dayWork", data.dayWork);
  fillSimpleSection("dayCheck", data.dayCheck);
  fillSimpleSection("nightWork", data.nightWork);
  fillSimpleSection("nightNote", data.nightNote);

  // 5) 법정점검 (여러 하위 필드)
  const legalSec = WORKLOG_LAYOUT.sections.legal;
  (data.legal || []).forEach((item, i) => {
    const r = legalSec.startRow + i;
    ws.getCell(r, legalSec.cols.sched).value = item.sched || "";
    ws.getCell(r, legalSec.cols.company).value = item.company || "";
    ws.getCell(r, legalSec.cols.contact).value = item.contact || "";
    ws.getCell(r, legalSec.cols.content).value = item.content || "";
  });

  // 6) 자재 입출고 (여러 하위 필드)
  const matSec = WORKLOG_LAYOUT.sections.material;
  (data.material || []).forEach((item, i) => {
    const r = matSec.startRow + i;
    ws.getCell(r, matSec.cols.workno).value = item.workno || "";
    ws.getCell(r, matSec.cols.partno).value = item.partno || "";
    ws.getCell(r, matSec.cols.qty).value = item.qty || "";
    ws.getCell(r, matSec.cols.unit).value = item.unit || "";
    ws.getCell(r, matSec.cols.usage).value = item.usage || "";
    ws.getCell(r, matSec.cols.date).value = item.date || "";
    ws.getCell(r, matSec.cols.stock).value = item.stock || "";
  });
}

// ──────────────────────────────────────────────
// [메인] 매일 09:00 (Asia/Seoul) 실행
// ──────────────────────────────────────────────
exports.workLogDailyExport = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Seoul" },
  async () => {
    // "지금 막 09:00를 지난 시점"의 workday는 오늘이 되므로, 어제 근무일을 명시적으로 계산
    const now = new Date();
    const yesterdayRef = new Date(now);
    yesterdayRef.setHours(now.getHours() - 1); // 09:00 직전(어제 근무일)로 되돌려서 workday 계산
    const workday = getWorkday(yesterdayRef);
    const [yyyy, mm, dd] = workday.split("-");
    const dayNum = parseInt(dd, 10);
    const monthNum = parseInt(mm, 10);

    let centers = [];
    try {
      const centersSnap = await db.collection("settings").doc("all_centers").get();
      centers = (centersSnap.data() || {}).centers || [];
    } catch (e) {
      console.error("[근무일지 내보내기] 센터 목록 조회 실패:", e);
      return;
    }

    let success = 0;
    for (const center of centers) {
      try {
        const data = await loadWorkLogData(center, workday);
        if (!data) {
          console.log(`[근무일지 내보내기] ${center} / ${workday} — 작성된 내용 없음, 스킵`);
          continue;
        }

        const fileName = `${yyyy}년_${monthNum}월_점검표.xlsx`;
        const filePath = `work_log/${center}/${fileName}`;
        const file = bucket.file(filePath);

        const workbook = new ExcelJS.Workbook();
        const [exists] = await file.exists();
        if (exists) {
          const [buf] = await file.download();
          await workbook.xlsx.load(buf);
        }

        const ws = resetSheet(workbook, `${dayNum}일`);
        fillWorkLogSheet(ws, data);

        const outBuf = await workbook.xlsx.writeBuffer();
        await file.save(outBuf, {
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });

        console.log(`[근무일지 내보내기 완료] ${center} / ${workday} → ${filePath}`);
        success++;
      } catch (e) {
        // 한 센터 실패해도 나머지 센터는 계속 처리
        console.error(`[근무일지 내보내기 실패] ${center} / ${workday}:`, e);
      }
    }
    console.log(`[근무일지 내보내기] 총 ${centers.length}개 센터 중 ${success}건 성공`);
  }
);

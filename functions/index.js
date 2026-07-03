/**
 * Firebase Functions - M-Engine 이슈 트래커
 *
 * [트리거] inspection_logs 문서 생성/수정 시 memo 필드 감지
 *          → events 컬렉션에 이벤트 생성
 *          → 해당 센터 관리자에게 이메일 발송.
 *
 * [배포]
 *   firebase deploy --only functions
 *
 * [환경변수 설정]
 *   환경변수 설정: GMAIL_USER, GMAIL_PASS (GitHub Secrets 또는 .env 파일)
 *   ※ functions.config() 우선, 없으면 process.env 폴백
 *     (functions.config()는 지원 종료 예정이므로 추후 .env 방식 전환 대비)
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

// ==============================================================================
// [유틸] Gmail 인증 정보 (functions.config() → process.env 순서로 조회)
// ==============================================================================
function getGmailAuth() {
  let cfg = {};
  try { cfg = functions.config().gmail || {}; } catch (e) { /* config 미설정 */ }
  return {
    user: cfg.user || process.env.GMAIL_USER || "",
    pass: cfg.pass || process.env.GMAIL_PASS || "",
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
// [트리거 1] inspection_logs 문서 생성/수정 감지
// memo 필드가 있으면 → events 컬렉션에 이벤트 생성 + 관리자 메일
//
// [중복 방지 전략]
//   이벤트 문서 ID를 `log_{logDocId}` 로 결정적으로 생성한다.
//   → 동일 로그에 대해 트리거가 동시에/재시도로 여러 번 실행돼도
//     같은 문서를 가리키므로 race condition에 의한 중복 생성이 불가능하다.
//   기존(랜덤 ID) 이벤트와의 호환을 위해 source_log_id 조회를 폴백으로 유지한다.
// ==============================================================================
exports.onInspectionLog = functions
  .region("asia-northeast3")
  .firestore
  .document("inspection_logs/{docId}")
  .onWrite(async (change, context) => {
    const after  = change.after.exists  ? change.after.data()  : null;
    const before = change.before.exists ? change.before.data() : null;

    // 삭제된 경우 스킵
    if (!after) return null;

    const memo = (after.memo || "").trim();
    if (!memo) return null;

    // memo가 새로 생기거나 변경된 경우만 처리
    const prevMemo = (before?.memo || "").trim();
    if (memo === prevMemo) return null;

    const center_name  = after.center_name  || "";
    const facility_id  = after.facility_id  || "";
    const worker      = after.worker      || "";
    const datetime    = after.datetime    || "";
    const photos      = after.photos      || "";
    const logDocId    = context.params.docId;

    // facility_info에서 fid_name 조회 (facility_id가 여러 개일 경우 첫 번째 값으로 조회)
    let fid_name = facility_id;
    try {
      const firstFid = (facility_id || "").split(",")[0].trim();
      if (firstFid) {
        const facDoc = await db.collection("center_configs")
          .doc(center_name).collection("facilities").doc(firstFid).get();
        if (facDoc.exists) fid_name = facDoc.data().fid_name || facility_id;
      }
    } catch(e) { console.warn("fid_name 조회 실패:", e); }

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
      return null;
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
      return null;
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

    return null;
  });


// ==============================================================================
// [트리거 2] events 문서 수정 감지 (조치/완료 상태 변경 시 관리자 메일)
// 웹페이지에서 조치사항 입력 or 완료 처리 시 자동 발송
// ==============================================================================
exports.onIssueUpdate = functions
  .region("asia-northeast3")
  .firestore
  .document("events/{eventId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after  = change.after.data();

    // 상태 변경 없으면 스킵
    if (before.status === after.status) return null;

    const center_name = after.center_name  || "";
    const facility_id = after.facility_id  || "";
    const memo       = after.memo         || "";
    const datetime   = after.datetime     || "";
    const eventId    = context.params.eventId;
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

    return null;
  });


// ==============================================================================
// [스케줄] 3일 경과 이슈 알림 (매일 09:00)
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
exports.issueReminderScheduler = functions
  .region("asia-northeast3")
  .pubsub
  .schedule("0 9 * * *")
  .timeZone("Asia/Seoul")
  .onRun(async () => {
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
      const issue    = doc.data();
      const center_name  = issue.center_name || "";
      const facility_id  = issue.facility_id || "";
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
    return null;
  });

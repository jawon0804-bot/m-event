/**
 * Firebase Functions - M-Engine 이슈 트래커
 * 
 * [트리거] inspection_logs 문서 생성/수정 시 memo 필드 감지
 *          → events 컬렉션에 이벤트 생성
 *          → 해당 센터 관리자에게 이메일 발송
 * 
 * [배포]
 *   firebase deploy --only functions
 * 
 * [환경변수 설정]
 *   firebase functions:config:set gmail.user="your@gmail.com" gmail.pass="앱비밀번호"
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

// Gmail SMTP 설정
const getTransporter = () => nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: functions.config().gmail.user,
    pass: functions.config().gmail.pass,
  },
});

// ==============================================================================
// [유틸] 센터 관리자 이메일 목록 조회
// ==============================================================================
async function getAdminEmails(center_name) {
  try {
    const snap = await db.collection("UserDB")
      .where("grade", "==", "관리자")
      .where("center", "in", [center_name, "Master"])
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
// ==============================================================================
async function sendMail(to, subject, html) {
  if (!to || to.length === 0) {
    console.warn("수신자 없음, 메일 발송 스킵");
    return;
  }
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"M-Engine 알림" <${functions.config().gmail.user}>`,
      to: Array.isArray(to) ? to.join(", ") : to,
      subject,
      html,
    });
    console.log("메일 발송 완료:", subject, "→", to);
  } catch (e) {
    console.error("메일 발송 실패:", e);
  }
}

// ==============================================================================
// [유틸] 이메일 HTML 템플릿
// ==============================================================================
function makeEmailHtml({ title, center_name, facility_id, worker, datetime, memo, actionUrl }) {
  return `
  <div style="font-family:Apple SD Gothic Neo,맑은 고딕,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    <div style="background:#1e3a5f;padding:20px 24px">
      <h2 style="color:#fff;margin:0;font-size:18px">🔧 M-Engine 이슈 알림</h2>
    </div>
    <div style="padding:24px">
      <h3 style="margin:0 0 16px;color:#111;font-size:16px">${title}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:8px 0;color:#6b7280;width:80px">센터</td><td style="padding:8px 0;color:#111;font-weight:600">${center_name}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">설비</td><td style="padding:8px 0;color:#111">${facility_id}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">점검자</td><td style="padding:8px 0;color:#111">${worker}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">일시</td><td style="padding:8px 0;color:#111">${datetime}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;vertical-align:top">내용</td>
            <td style="padding:8px 0;color:#dc2626;font-weight:600">${memo}</td></tr>
      </table>
      ${actionUrl ? `
      <div style="margin-top:24px;text-align:center">
        <a href="${actionUrl}" style="display:inline-block;background:#1e3a5f;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">
          이슈 트래커에서 확인하기 →
        </a>
      </div>` : ""}
    </div>
    <div style="background:#f9fafb;padding:12px 24px;font-size:12px;color:#9ca3af;text-align:center">
      M-Engine 자동 발송 메일입니다.
    </div>
  </div>`;
}

// ==============================================================================
// [트리거 1] inspection_logs 문서 생성/수정 감지
// memo 필드가 있으면 → events 컬렉션에 이벤트 생성 + 관리자 메일
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

    console.log(`[이슈 생성] ${center_name} / ${facility_id} / memo: ${memo}`);

    // events 컬렉션에 이미 같은 로그로 만들어진 이슈가 있는지 확인 (중복 방지)
    const existing = await db.collection("events")
      .where("source_log_id", "==", logDocId)
      .limit(1)
      .get();

    let eventRef;

    if (!existing.empty) {
      // 기존 이슈가 있으면 memo 업데이트만
      eventRef = existing.docs[0].ref;
      await eventRef.update({
        memo,
        photos,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("[이슈 업데이트] 기존 이슈 memo 수정:", eventRef.id);
      return null;
    }

    // 새 이슈 생성
    eventRef = db.collection("events").doc();
    await eventRef.set({
      // 기본 정보
      center_name:    center_name,
      facility_id:    facility_id,
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
      `[이슈 발생] ${center_name} - ${facility_id} - ${memo}`,
      makeEmailHtml({
        title:      "🔴 새 이슈가 등록되었습니다",
        center_name: center_name, facility_id: facility_id, worker, datetime,
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
          title:      "🟡 이슈 조치가 시작되었습니다",
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
        `[이슈 완료] ${center_name} - ${facility_id} - ${memo}`,
        makeEmailHtml({
          title:      "🟢 이슈가 완료 처리되었습니다",
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
      .where("status", "!=", "완료")
      .where("last_notified_at", "<=", threshold)
      .get();

    console.log(`[3일 알림] 대상 이슈: ${snap.size}건`);

    const batch = db.batch();

    for (const doc of snap.docs) {
      const issue    = doc.data();
      const center_name  = issue.center_name || "";
      const facility_id  = issue.facility_id || "";
      const memo        = issue.memo        || "";
      const status      = issue.status      || "";
      const count       = (issue.notified_count || 0) + 1;
      const eventUrl    = `https://m-smart-0804.web.app/index.html?id=${doc.id}`;

      const adminEmails = await getAdminEmails(center_name);

      await sendMail(
        adminEmails,
        `[${count}차 미조치 알림] ${center_name} - ${facility_id} - ${memo}`,
        makeEmailHtml({
          title:      `⚠️ 미처리 이슈 ${count}차 알림 (현재 상태: ${status})`,
          center_name: center_name, facility_id: facility_id,
          worker:     issue.worker   || "",
          datetime:   issue.datetime || "",
          memo:       `${memo}\n\n※ 이 이슈는 3일 이상 처리되지 않아 재알림이 발송됩니다.`,
          actionUrl:  eventUrl,
        })
      );

      // last_notified_at 업데이트
      batch.update(doc.ref, {
        last_notified_at: admin.firestore.Timestamp.now(),
        notified_count:   count,
      });
    }

    await batch.commit();
    console.log(`[3일 알림] 완료: ${snap.size}건 처리`);
    return null;
  });

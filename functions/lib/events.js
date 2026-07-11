// lib/events.js
// 이벤트 트래커 트리거 2개 + 3일 미조치 알림 스케줄
const { onDocumentWritten, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { admin, db, GMAIL_USER, GMAIL_PASS } = require("./firebase");
const { sendMail, makeEmailHtml, getAdminEmails } = require("./mail");

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

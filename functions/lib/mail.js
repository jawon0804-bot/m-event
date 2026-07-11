// lib/mail.js
// 이메일 발송 관련 유틸 (Gmail 인증, 관리자 이메일 조회, 발송, 본문 템플릿)
const nodemailer = require("nodemailer");
const { db, GMAIL_USER, GMAIL_PASS } = require("./firebase");

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

function makeEmailHtml({ title, center_name, facility_id, fid_name, worker, workerLabel = "점검자", datetime, memo, actionUrl }) {
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
        <tr><td style="padding:8px 0;color:#6b7280">${escHtml(workerLabel)}</td><td style="padding:8px 0;color:#111">${escHtml(worker)}</td></tr>
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

module.exports = { getGmailAuth, sendMail, makeEmailHtml, getAdminEmails, escHtml, nl2br };

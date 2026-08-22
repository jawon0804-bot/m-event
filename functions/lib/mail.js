// lib/mail.js
// 이메일 발송 관련 유틸 (Gmail 인증, 관리자 이메일 조회, 발송, 본문 템플릿)
// ⚠️ nodemailer는 여기서 최상위 require를 하지 않는다 — 실제로 쓰는 함수 안에서 받는다.
//    Firebase Functions 2nd Gen은 코드베이스 전체를 컨테이너 이미지 하나로 빌드하므로,
//    index.js가 이 파일을 불러오는 순간 이 무거운 모듈이 **모든 함수**의 콜드 스타트에 얹힌다.
//    loginWithCredentials는 이름·전화번호 조회가 전부인데 콜드 스타트가 2,473ms였고,
//    그 절반 이상이 엑셀·메일 모듈 로드였다(2026-08-22 측정, M-SMART 로그인도 같은 함수를 쓴다).
//    require는 Node가 캐시하므로 함수 안에서 받아도 두 번째 호출부터는 비용이 없다.
//    ⛔ 이 줄들을 편의상 최상위로 되돌리지 말 것 — 되돌리는 순간 로그인이 다시 3초가 된다.
const { db, GMAIL_USER, GMAIL_PASS } = require("./firebase");
const { shouldReceiveMail } = require("./permissions");

// ==============================================================================
// [유틸] Gmail 인증 정보 (Secret Manager)
// ==============================================================================
function getGmailAuth() {
  return { user: GMAIL_USER.value(), pass: GMAIL_PASS.value() };
}

const getTransporter = () => {
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({ service: "gmail", auth: getGmailAuth() });
};

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
//
// ⚠️ [2026-08-01] 필터를 쿼리에서 코드로 옮겼다. 예전엔
//   `.where("center_name","==",c).where("active","==",true)` 였는데, 여기에
//   notify_email 조건까지 등호로 더하면 두 가지 문제가 생긴다:
//     ① 등호 3개면 Firestore 복합 인덱스가 필요해진다.
//     ② 더 나쁜 건, **필드가 없는 문서는 `== true` 쿼리에 아예 안 걸린다.**
//        백필을 한 명이라도 빠뜨리면 그 사람에게 알림이 조용히 끊기고 에러도 안 난다.
//        알림 시스템에서 제일 나쁜 실패 모드다.
//   UserDB는 관리자가 수동 등록하는 작은 컬렉션(2026-08-01 기준 9개 문서)이라
//   센터 단위로 받아서 메모리에서 거르는 비용이 무시할 수준이다.
//   → 판정 규칙은 lib/permissions.js의 shouldReceiveMail() 한 곳에만 둔다.
//     (활성 계정 + 관리자 + 수신 거부 안 함. 값이 없으면 수신 쪽으로 fail-open)
//
// 📌 Master 계정은 여기서 자연히 제외된다 — center_name 정확일치라 "Master"는 어느
//   센터 쿼리에도 안 걸린다. **의도된 동작이다**(2026-08-01 결정). 전 센터 관리자가
//   센터별 개별 알림을 전부 받으면 노이즈가 되기 때문. 이 함수의 조회 범위를 나중에
//   바꾸더라도 Master에게 전 센터 알림이 쏟아지지 않도록 유지할 것.
// ==============================================================================
async function getAdminEmails(center_name) {
  try {
    const snap = await db.collection("UserDB")
      .where("center_name", "==", center_name)
      .get();
    return snap.docs
      .map(d => d.data())
      .filter(shouldReceiveMail)
      .map(u => u.email)
      .filter(Boolean);
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

// lib/auth.js
// [로그인] loginWithCredentials — 이름+전화번호 로그인을 서버(Cloud Function)에서 처리
//
// 기존 문제: 프런트엔드가 UserDB를 직접 조회해서 로그인 판정을 하고 있었음.
//   → 클라이언트가 결과를 조작할 수 있고, 로그인 시도 자체가 서버를 거치지 않아
//     "누가/언제/어느 IP에서 시도했는지" 전혀 기록이 안 남는 문제가 있었음
//   → 특히 A센터 사용자가 B센터 관리자의 이름+전화번호를 알아내 로그인하는 것을
//     막을 수도, 추적할 수도 없었음 (2026-07 설계 논의로 확인됨)
//
// 이 함수가 하는 일:
//   1. 이름 기준으로 로그인 시도 잠금 여부 확인 (5회 실패 시 15분 잠금)
//   2. UserDB 대조 (서버에서 수행 — 클라이언트가 판정 결과를 조작 불가)
//   3. [향후 확장 지점] UserDB 문서에 password_hash가 있으면 비밀번호도 검증 (지금은 미구현)
//   4. 성공/실패 관계없이 login_attempts에 IP·기기정보·시도 이름/전화번호 기록
//   5. 성공 시 Firebase Custom Token 발급 → 프런트가 firebase.auth()로 진짜 로그인
//      (커스텀 클레임에 center_name/active를 심어서, Firestore 보안 규칙에서
//       request.auth.token.center_name 으로 실제 접근 제어에 쓸 수 있게 함 — 규칙은 별도 작업 필요)
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("./firebase");
const {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
  IP_MAX_ATTEMPTS,
  IP_LOCKOUT_MINUTES,
  LOGIN_ATTEMPT_RETENTION_DAYS,
} = require("../config/constants");

// 로그인 시도 결과를 잠금 문서에 원자적으로 반영 (동시 요청 레이스 방지)
// maxAttempts/lockoutMinutes를 받아서 이름 단위/IP 단위 양쪽에 재사용
async function registerLoginResult(lockRef, success, maxAttempts = LOGIN_MAX_ATTEMPTS, lockoutMinutes = LOGIN_LOCKOUT_MINUTES) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    const data = snap.exists ? snap.data() : {};
    const now  = Date.now();

    if (success) {
      tx.set(lockRef, { failCount: 0, lockedUntil: null, updated_at: admin.firestore.Timestamp.now() }, { merge: true });
      return { justLocked: false, attemptsLeft: null };
    }

    const nextCount  = (data.failCount || 0) + 1;
    const justLocked = nextCount >= maxAttempts;

    tx.set(lockRef, {
      failCount: justLocked ? 0 : nextCount, // 잠금 걸리면 카운트 리셋 (해제 후 다시 처음부터)
      lockedUntil: justLocked
        ? admin.firestore.Timestamp.fromMillis(now + lockoutMinutes * 60 * 1000)
        : null,
      updated_at: admin.firestore.Timestamp.now(),
    }, { merge: true });

    return { justLocked, attemptsLeft: justLocked ? 0 : maxAttempts - nextCount };
  });
}

// IP를 Firestore 문서 ID로 쓸 수 있게 정리 (슬래시가 경로 구분자와 충돌하므로 치환)
function sanitizeIpForDocId(ip) {
  return String(ip || "").trim().replace(/\//g, "_");
}

// 로그인 시도 기록 (성공/실패/차단 관계없이 항상 남김) — 기록 실패가 로그인 자체를 막으면 안 되므로 별도 try/catch
async function logLoginAttempt({ name, phone, ip, userAgent, success, blocked, matchedCenter, app }) {
  try {
    await db.collection("login_attempts").add({
      input_name: name,
      input_phone: phone,      // 실제 입력된 번호 그대로 기록 (본인 것인지 도용인지는 사후 대조용)
      matched_center: matchedCenter,
      app,                     // 어떤 앱(M-Event/M-SMART 등)에서 시도했는지
      success, blocked,
      ip, user_agent: userAgent,
      at: admin.firestore.FieldValue.serverTimestamp(),
      // [2026-07-11 추가] Firestore TTL 정책 대상 필드 — expireAt이 지나면
      // Firestore가 자동으로 문서를 삭제한다 (별도 삭제 배치 불필요).
      // 정책 자체는 `gcloud firestore fields ttls update`로 등록해야 동작함.
      expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + LOGIN_ATTEMPT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch (e) {
    console.error("[로그인] 시도 기록 실패:", e);
  }
}

// ==============================================================================
// [다중 앱 지원] 같은 UserDB/로그인 시스템을 M-Event 외 다른 앱(예: M-SMART)도 공유해서 씀.
// UserDB 문서에 allowed_apps: string[] 필드를 선택적으로 둘 수 있음:
//   - 필드가 아예 없으면(기존 사용자 전부 해당) → 모든 앱에서 로그인 허용 (하위호환, 기본 동작 안 바뀜)
//   - ["m-event"] 처럼 지정하면 → 그 배열에 있는 앱에서만 로그인 허용
// 호출하는 쪽(M-Event, M-SMART 등)은 loginWithCredentials({name, phone, app: "자기앱ID"})
// 형태로 자신의 app ID를 실어서 호출하면 됨. Callable Function이라 같은 Firebase 프로젝트
// 안이면 어느 Hosting 사이트/도메인에서 호출해도 별도 CORS 설정 없이 그대로 동작함.
// ⚠️ 단, Firebase Auth 로그인 세션(auth.onAuthStateChanged)은 브라우저 origin(도메인)
//   단위로 저장되므로, M-Event와 M-SMART가 서로 다른 도메인이면 한쪽 로그인이 다른 쪽에
//   자동으로 이어지진 않음 — 앱마다 이 함수를 각자 호출해서 각자 로그인해야 함
//   (완전 자동 SSO를 원하면 별도의 리다이렉트 기반 연동이 추가로 필요함).
// ==============================================================================
function isAppAllowed(userData, appId) {
  const allowed = userData.allowed_apps;
  if (!Array.isArray(allowed)) return true; // 필드 없으면 전체 허용 (기존 사용자 호환)
  return allowed.includes(appId);
}

exports.loginWithCredentials = onCall(async (request) => {
  const { name, phone, app /*, password (향후 확장) */ } = request.data || {};
  const rawRequest = request.rawRequest;
  const ip = (rawRequest?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || rawRequest?.ip || "";
  const userAgent = rawRequest?.headers?.["user-agent"] || "";

  const cleanName  = String(name || "").trim();
  const cleanPhone = String(phone || "").replace(/[^0-9]/g, "");
  const appId      = String(app || "m-event").trim(); // 안 넘기면 기존 M-Event 호출부와 호환되게 기본값 사용
  if (!cleanName || !cleanPhone) {
    throw new HttpsError("invalid-argument", "이름과 전화번호를 입력하세요.");
  }

  // 1) 잠금 여부 먼저 확인 — UserDB 조회 전에 차단해서 무차별 대입 비용을 낮춤
  //    (이름 단위 잠금은 어느 앱으로 시도하든 같은 사람을 노린 시도이므로 합산)
  const lockRef = db.collection("login_lockouts").doc(cleanName);
  const preCheck = await lockRef.get();
  if (preCheck.exists) {
    const d = preCheck.data();
    if (d.lockedUntil && d.lockedUntil.toMillis() > Date.now()) {
      await logLoginAttempt({ name: cleanName, phone: cleanPhone, ip, userAgent, success: false, blocked: true, matchedCenter: null, app: appId });
      const remainMin = Math.ceil((d.lockedUntil.toMillis() - Date.now()) / 60000);
      throw new HttpsError("resource-exhausted", `로그인 시도가 너무 많습니다. ${remainMin}분 후 다시 시도하세요.`);
    }
  }

  // 1-2) [2026-07-11 추가] IP 단위 잠금도 확인 — 이름을 바꿔가며 시도해서 이름 단위
  //      잠금을 우회하는 공격을 막기 위함 (위 IP_MAX_ATTEMPTS 주석 참고)
  const ipDocId = sanitizeIpForDocId(ip);
  const ipLockRef = ipDocId ? db.collection("login_lockouts_ip").doc(ipDocId) : null;
  if (ipLockRef) {
    const ipPreCheck = await ipLockRef.get();
    if (ipPreCheck.exists) {
      const d = ipPreCheck.data();
      if (d.lockedUntil && d.lockedUntil.toMillis() > Date.now()) {
        await logLoginAttempt({ name: cleanName, phone: cleanPhone, ip, userAgent, success: false, blocked: true, matchedCenter: null, app: appId });
        const remainMin = Math.ceil((d.lockedUntil.toMillis() - Date.now()) / 60000);
        throw new HttpsError("resource-exhausted", `이 네트워크에서 로그인 시도가 너무 많습니다. ${remainMin}분 후 다시 시도하세요.`);
      }
    }
  }

  // 2) UserDB 대조 (서버에서 수행)
  let matched = null;
  try {
    const snap = await db.collection("UserDB").where("name", "==", cleanName).limit(5).get();
    matched = snap.docs.find(d => (d.data().phone || "").replace(/[^0-9]/g, "") === cleanPhone) || null;
  } catch (e) {
    console.error("[로그인] UserDB 조회 실패:", e);
    throw new HttpsError("internal", "로그인 중 오류가 발생했습니다.");
  }

  // 이름+전화번호는 맞아도 이 앱 사용 권한이 없으면 로그인 실패로 처리 (잠금 카운트에도 반영)
  if (matched && !isAppAllowed(matched.data(), appId)) {
    console.warn(`[로그인] ${cleanName}은(는) "${appId}" 앱 사용 권한 없음 (allowed_apps 확인)`);
    matched = null;
  }

  // [향후 확장 지점] UserDB 문서에 password_hash 필드가 생기면 여기서 비밀번호 검증 추가.
  // 지금은 어떤 계정도 password_hash가 없어 이 분기는 타지 않음 — 이름+전화번호만으로 통과.
  // 도입 시: functions/package.json에 "bcryptjs" 추가 후
  //   const bcrypt = require("bcryptjs");
  //   const ok = await bcrypt.compare(password || "", matched.data().password_hash);
  //   if (!ok) matched = null;
  if (matched && matched.data().password_hash) {
    console.warn(`[로그인] ${cleanName} 계정에 password_hash가 있으나 검증 로직 미구현 — bcryptjs 추가 필요`);
  }

  // 3) 시도 카운트 갱신 (성공이면 리셋, 실패면 증가) — 이름 단위 + IP 단위 둘 다 반영
  const lockResult = await registerLoginResult(lockRef, !!matched);
  if (ipLockRef) {
    await registerLoginResult(ipLockRef, !!matched, IP_MAX_ATTEMPTS, IP_LOCKOUT_MINUTES);
  }

  // 4) 성공/실패 무관하게 항상 기록
  await logLoginAttempt({
    name: cleanName, phone: cleanPhone, ip, userAgent,
    success: !!matched, blocked: false,
    matchedCenter: matched ? matched.data().center_name : null,
    app: appId,
  });

  if (!matched) {
    if (lockResult.justLocked) {
      throw new HttpsError("resource-exhausted", `로그인 시도가 너무 많습니다. ${LOGIN_LOCKOUT_MINUTES}분 후 다시 시도하세요.`);
    }
    const leftMsg = lockResult.attemptsLeft != null ? ` (남은 시도 ${lockResult.attemptsLeft}회)` : "";
    throw new HttpsError("unauthenticated", `이름 또는 전화번호가 일치하지 않습니다.${leftMsg}`);
  }

  // 5) 성공 — Custom Token 발급 (커스텀 클레임에 center_name/active/name/apps 포함)
  const userData = matched.data();
  const token = await admin.auth().createCustomToken(matched.id, {
    name: userData.name || cleanName,
    center_name: userData.center_name || "",
    active: userData.active === true,
    apps: userData.allowed_apps || null, // null이면 "전체 허용" 의미 (isAppAllowed와 동일 규칙)
  });

  return {
    token,
    user: {
      name: userData.name || cleanName,
      center_name: userData.center_name || "",
      active: userData.active === true,
      email: userData.email || "",
      allowed_apps: userData.allowed_apps || null,
    },
  };
});

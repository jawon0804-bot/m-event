// ==============================================================================
// lib/permissions.js — 권한 판정을 한 곳으로 모은 모듈
//
// [2026-08-01 신설] 그전까지 권한 판정은 `claims.active === true || isMaster`가
// 서로 다른 파일 4곳에 복붙돼 있었고, Dashboard(server.js)와 M-Engine(notifications.py)엔
// 또 다른 형태로 흩어져 있었다. 필드 하나가 세 가지 일을 겸하고 있었기 때문이다:
//
//   지금까지의 `active: true` = ① 계정 활성 + ② 관리자 권한 + ③ 알림메일 수신
//
// 그래서 "메일을 받게 하려고 active를 켜면 그 사람이 센터 전체 보고서 권한까지
// 자동으로 얻는" 상태였다. 이걸 축별로 쪼갠다:
//
//   role         : 관리자 권한          ("admin" | "user")
//   active       : 계정 활성(로그인 가부)  (true | false)
//   notify_email : 알림메일 수신 여부       (true | false)
//   center_name  : 데이터 범위            (센터명 | "Master")
//   grade        : 직급(센터장/과장/팀장) — 표시용이며 권한과 무관하다. 읽지 말 것.
//
// ------------------------------------------------------------------------------
// [전환기 폴백] role이 없으면 예전 의미(active === true)로 판정한다.
//
// UserDB의 정본은 이 저장소가 아니라 **구글시트**이고, 시트→Firestore 동기화는
// Apps Script `syncUsersToFirebase`가 담당한다(저장소 밖 코드). 즉 코드 배포와
// 시트 백필은 원자적으로 같이 일어날 수 없다. 폴백이 없으면 배포가 백필보다
// 먼저 도착하는 순간 관리자 전원이 권한을 잃는다.
//
// 폴백 덕분에 배포/백필 순서가 어긋나도 동작이 바뀌지 않는다:
//   · role 없음 + active:true  → 관리자 (지금과 동일)
//   · role 없음 + active:false → 일반   (지금과 동일)
//   · role 있음                → role이 이김
//
// 📌 백필이 끝나면(UserDB 전 문서에 role 존재) hasRole()과 폴백 두 줄만 지우면 된다.
//    지우기 전에 반드시 확인할 것 — role이 빠진 문서가 하나라도 남아 있으면
//    그 사람은 조용히 일반 사용자로 강등된다.
// ==============================================================================

const MASTER_CENTER_NAME = "Master";
const ROLE_ADMIN = "admin";
const ROLE_USER  = "user";

// UserDB 문서(Admin SDK)와 커스텀 클레임(Callable) 양쪽 모두 이 함수들에 넣을 수 있다 —
// 필드명이 같기 때문. auth.js가 클레임에 role을 그대로 실어 보낸다.

function hasRole(src) {
  return !!src && typeof src.role === "string" && src.role !== "";
}

/**
 * 관리자 권한 — Dashboard 접근, 보고서 생성·다운로드, 출근부 템플릿 업로드,
 * 엑셀 통합본 생성, 알림메일 수신.
 *
 * ⚠️ Master는 여기에 자동으로 포함되지 않는다. 예전 코드는 `active || isMaster`처럼
 *   OR로 묶여 있었는데, 그러면 center_name이 범위와 권한을 겸하게 되어
 *   "전 센터를 열람하되 보고서는 만들지 않는 계정"을 표현할 방법이 없었다.
 *   Master 계정도 관리자여야 한다면 UserDB에 role:"admin"을 명시할 것.
 *   (전환기에는 폴백이 active:true를 보고 그대로 관리자로 판정하므로 당장은 안 바뀐다)
 */
function isAdmin(src) {
  if (!src) return false;
  if (hasRole(src)) return src.role === ROLE_ADMIN;
  return src.active === true;            // [전환기 폴백] — 백필 완료 후 제거
}

/** 데이터 범위가 전 센터인가 (조회 범위이지 권한이 아니다) */
function isMaster(src) {
  return !!src && src.center_name === MASTER_CENTER_NAME;
}

// ⚠️ 예전에 있던 `isAdminOrMaster`(= active || Master)에 해당하는 헬퍼는 **일부러 두지 않는다.**
//   그게 있으면 Master가 자동으로 관리자가 되어, 지금 분리하려는 것(범위 ≠ 권한)이
//   그대로 되돌아온다. 권한이 필요한 자리엔 isAdmin()만 쓰고, isMaster()는 조회 범위를
//   정하는 자리(어느 센터를 볼지)에만 쓸 것.
//   Master 계정도 보고서를 만들어야 하면 UserDB에 role:"admin"을 명시한다.

/**
 * 계정 활성(로그인 가부).
 * 값이 없으면 **활성으로 본다(fail-open)** — 잘못 잠기면 현장 점검이 멈추기 때문이다.
 * 퇴사자 차단은 active:false를 명시적으로 넣어서 한다.
 */
function isActiveAccount(src) {
  return !!src && src.active !== false;
}

/**
 * 알림메일 수신 여부.
 * 값이 없으면 **수신으로 본다(fail-open)** — 알림이 조용히 끊기는 게 최악의 실패라서다.
 * 받기 싫은 관리자만 notify_email:false를 넣으면 된다.
 */
function wantsMail(src) {
  return !!src && src.notify_email !== false;
}

/**
 * 알림메일을 실제로 받을 사람인가 — 위 셋의 조합.
 * (활성 계정이고, 관리자이고, 수신을 끄지 않았을 것)
 *
 * 📌 Master는 여기서 자연히 빠진다. 메일 조회가 center_name 정확일치로 센터별로
 *   돌기 때문에 center_name:"Master"인 계정은 어느 센터 쿼리에도 안 걸린다.
 *   **이건 의도된 동작이다**(2026-08-01 결정) — 전 센터 관리자가 모든 센터의
 *   개별 알림을 다 받으면 노이즈가 된다. 나중에 메일 조회 범위를 바꾸더라도
 *   Master에게 전 센터 알림이 쏟아지지 않게 이 결정을 유지할 것.
 */
function shouldReceiveMail(src) {
  return isActiveAccount(src) && isAdmin(src) && wantsMail(src);
}

module.exports = {
  MASTER_CENTER_NAME,
  ROLE_ADMIN,
  ROLE_USER,
  hasRole,
  isAdmin,
  isMaster,
  isActiveAccount,
  wantsMail,
  shouldReceiveMail,
};

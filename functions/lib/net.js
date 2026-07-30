// lib/net.js
// 요청에서 "위조 불가능한" 클라이언트 IP를 뽑는다. 로그인 시도 제한(login_lockouts_ip)의
// 키로 쓰이므로, 이 값이 클라이언트 마음대로 바뀌면 IP 단위 잠금 자체가 무의미해진다.
//
// ==============================================================================
// [2026-07-30 실측으로 판정 완료] X-Forwarded-For 체인의 어느 항목이 진짜인가
// ==============================================================================
// 2026-07-27에 "어느 항목이 신뢰 가능한지 모른다"는 이유로 판정을 보류하고,
// login_attempts.xff_chain에 원본 체인을 기록만 해뒀다(lib/auth.js 참고).
// 2026-07-30에 실제 배포된 엔드포인트에 위조 헤더를 넣어 확인한 결과:
//
//   보낸 헤더                              함수가 받은 체인
//   ------------------------------------   ---------------------------------------------
//   X-Forwarded-For: 203.0.113.7           "203.0.113.7,121.176.138.112"
//   X-Forwarded-For: 203.0.113.7,          "203.0.113.7, 198.51.100.9,121.176.138.112"
//                    198.51.100.9
//
//   (121.176.138.112 = 요청을 실제로 보낸 회선의 공인 IP. 위조 헤더를 안 보낸 정상
//    로그인 6건의 체인이 이 IP 한 항목뿐인 것과도 일치한다.)
//
// 결론:
//   - GCP 인프라는 클라이언트가 보낸 XFF를 **지우지 않고 그대로 두고, 진짜 IP를 맨 뒤에
//     덧붙인다.** → 앞쪽 항목은 전부 클라이언트가 원하는 값으로 채울 수 있다.
//   - 따라서 **맨 뒤 항목만** 신뢰할 수 있다. 예전 코드는 `split(",")[0]`(맨 앞)을 써서
//     헤더 한 줄로 IP 잠금을 우회할 수 있었다.
//   - 맨 뒤 항목은 요청자별로 다른 실제 IP였다(Google LB의 공용 IP가 아니었다).
//     즉 "맨 뒤를 쓰면 전 사용자가 한 키로 합산돼 전역 잠금(DoS)이 된다"는 07-27의
//     우려는 이 배포 형태에서는 해당되지 않는다.
//
// ⚠️ 이 판정은 **배포 형태에 의존한다.** 지금은 요청이
//    `asia-northeast3-m-smart-90148.cloudfunctions.net`으로 직접 들어와서 인프라가
//    덧붙이는 항목이 정확히 1개다. 앞에 외부 HTTP(S) 로드밸런서나 CDN(Cloudflare 등)을
//    두면 덧붙는 항목이 늘어나고, 그때는 맨 뒤가 LB IP가 되어 위의 전역 잠금 위험이
//    현실이 된다. **그런 변경을 하면 아래 상수를 반드시 다시 실측해서 맞출 것.**
//    재실측 방법: login_attempts.xff_chain(원본 체인)을 그대로 기록하고 있으므로,
//    위조 헤더를 넣은 요청 1건을 보내 그 필드를 보면 된다.
//
// 신뢰하는 프록시 홉 수 = 인프라가 체인 뒤에 덧붙이는 항목 수.
// 뒤에서 이만큼 세어 들어간 항목이 진짜 클라이언트 IP다.
const TRUSTED_PROXY_HOPS = 1;

// xffChain: X-Forwarded-For 헤더 원본 문자열, fallbackIp: 헤더가 아예 없을 때 쓸 값
function clientIpFromChain(xffChain, fallbackIp) {
  const parts = String(xffChain || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // 체인이 홉 수보다 짧으면(= 인프라가 덧붙인 항목까지 없으면) 신뢰할 항목이 없다.
  // 이 경우만 소켓 주소로 후퇴한다.
  if (parts.length >= TRUSTED_PROXY_HOPS) {
    return parts[parts.length - TRUSTED_PROXY_HOPS];
  }
  return String(fallbackIp || "").trim();
}

// Cloud Functions(onCall)의 request.rawRequest를 그대로 받는 편의 함수
function clientIp(rawRequest) {
  return clientIpFromChain(
    rawRequest?.headers?.["x-forwarded-for"],
    rawRequest?.ip,
  );
}

// xffChain 원본을 진단용으로 그대로 저장하기 위한 정규화(문자열 보장만)
function rawXffChain(rawRequest) {
  return String(rawRequest?.headers?.["x-forwarded-for"] || "");
}

module.exports = { TRUSTED_PROXY_HOPS, clientIpFromChain, clientIp, rawXffChain };

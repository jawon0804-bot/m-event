// tests/client-ip.test.js
// lib/net.js의 클라이언트 IP 판정을 고정한다. 외부 의존이 전혀 없어서 그냥 돌아간다.
//
// 실행:
//   node tests/client-ip.test.js
//
// [왜 이 테스트가 있는가]
// 2026-07-11에 이름 단위 로그인 잠금의 우회를 막으려고 IP 단위 잠금을 추가했는데,
// IP를 X-Forwarded-For의 **맨 앞** 항목으로 뽑고 있었다. 2026-07-30 실측 결과 GCP는
// 클라이언트가 보낸 XFF를 지우지 않고 진짜 IP를 **맨 뒤에 덧붙이는** 방식이어서,
// 맨 앞 항목은 공격자가 매 요청마다 바꿔 넣을 수 있는 값이었다 — IP 잠금이 헤더
// 한 줄로 무력화되는 상태였다.
//
// 이 파일은 그 실측 결과를 그대로 케이스로 굳혀둔 것이다. 누군가 "XFF는 보통 맨 앞이
// 클라이언트 IP"라는 일반 상식으로 되돌리면 여기서 깨진다.
const assert = require("assert");
const { clientIpFromChain, TRUSTED_PROXY_HOPS } = require("../functions/lib/net");

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    console.log(`  ✅ ${label}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${label}\n       기대: ${JSON.stringify(expected)}  실제: ${JSON.stringify(actual)}`);
    fail++;
  }
}

console.log("\n[실측 재현] 2026-07-30 프로덕션 엔드포인트에 위조 헤더를 넣어 받은 실제 체인");
// 정상 클라이언트(XFF를 직접 안 보냄) — 인프라가 덧붙인 1개만 존재
check(
  "정상 로그인: 체인이 1개면 그게 클라이언트 IP",
  clientIpFromChain("121.176.138.112", "10.0.0.1"),
  "121.176.138.112",
);
// 위조 1개 — 진짜 IP가 뒤에 덧붙는다
check(
  "위조 1개: 앞의 위조값이 아니라 맨 뒤(진짜)를 골라야 한다",
  clientIpFromChain("203.0.113.7,121.176.138.112", "10.0.0.1"),
  "121.176.138.112",
);
// 위조 2개(공백 포함) — 실측에서 받은 형태 그대로
check(
  "위조 2개 + 공백: 여전히 맨 뒤",
  clientIpFromChain("203.0.113.7, 198.51.100.9,121.176.138.112", "10.0.0.1"),
  "121.176.138.112",
);

console.log("\n[우회 시도] 잠금 키를 흔들려는 입력들");
// 공격자가 매 요청 앞부분만 바꿔도 잠금 키(=반환값)는 고정돼야 한다
const keys = [
  clientIpFromChain("1.1.1.1,121.176.138.112"),
  clientIpFromChain("2.2.2.2,121.176.138.112"),
  clientIpFromChain("3.3.3.3, 4.4.4.4, 5.5.5.5,121.176.138.112"),
];
check("앞부분을 매번 바꿔도 판정 결과는 동일 (잠금 우회 불가)", new Set(keys).size, 1);
check("  그 값은 진짜 IP", keys[0], "121.176.138.112");

console.log("\n[경계값]");
check("헤더 없음 → 소켓 주소로 후퇴", clientIpFromChain("", "10.0.0.1"), "10.0.0.1");
check("헤더 없음 + 후퇴값도 없음 → 빈 문자열", clientIpFromChain("", ""), "");
check("undefined 입력", clientIpFromChain(undefined, undefined), "");
check("쉼표만 온 경우", clientIpFromChain(",,,", "10.0.0.1"), "10.0.0.1");
check("빈 항목 섞임 → 빈 항목은 무시", clientIpFromChain("203.0.113.7,,121.176.138.112"), "121.176.138.112");
check("앞뒤 공백 제거", clientIpFromChain("  121.176.138.112  "), "121.176.138.112");
// 실측에 IPv6 클라이언트(2001:4430:...)가 있었다 — 콜론이 잘리면 안 된다
check(
  "IPv6 클라이언트",
  clientIpFromChain("203.0.113.7, 2001:4430:417a:b404:94b6:8e46:64bd:b093"),
  "2001:4430:417a:b404:94b6:8e46:64bd:b093",
);

console.log("\n[전제 확인]");
check(
  "홉 수가 1이어야 위 케이스들이 성립 (배포 형태가 바뀌면 실측 후 이 값과 케이스를 같이 고칠 것)",
  TRUSTED_PROXY_HOPS,
  1,
);

console.log(`\n결과: ${pass}건 통과, ${fail}건 실패\n`);
process.exit(fail === 0 ? 0 : 1);

// lib/dateUtils.js
// KST 기준 연/월/일 파트 추출 (프런트엔드 wlGetWorkday와 동일 원리 — Intl 사용, 로캘 파싱 문제 없음)
function getKstDateParts(d) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { y: parseInt(parts.year, 10), m: parseInt(parts.month, 10), d: parseInt(parts.day, 10) };
}

module.exports = { getKstDateParts };

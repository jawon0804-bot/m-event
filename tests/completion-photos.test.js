// tests/completion-photos.test.js
// 완료 사진 업로드의 "자리(slot) 계산"과 저장 경로 규칙을 고정한다.
//
// 실행:
//   node tests/completion-photos.test.js
//
// [왜 이 테스트가 있는가]
// 완료 사진은 파일명의 순번이 곧 **보고서 J·K열의 자리**이고, 동시에 **교체 수단**이다
// (같은 경로에 덮어쓰는 게 교체다 — Storage 규칙에서 delete는 안 열었다).
// 그래서 여기서 인덱스가 하나만 어긋나면 증상이 이렇게 나온다:
//   · 추가로 올린 사진이 1번 자리를 덮어써서 **앞 사진이 소리 없이 사라진다**
//   · 교체했는데 2번 자리에 붙어서 옛 사진이 그대로 남는다
// 둘 다 에러 없이 "사진이 이상하다"로만 나타나서 원인을 찾기 어렵다.
//
// ⚠️ 여기서 검증하지 않는 것: put() 뒤에 getDownloadURL()을 다시 받는지.
//   같은 경로를 덮어쓰면 GCS가 메타데이터를 교체해 다운로드 토큰이 새로 발급되므로
//   **이전 URL은 죽는다.** 그 순서는 uploadDonePhotos 안에 주석으로 고정해 뒀다.
//
// [왜 require 대신 소스에서 함수를 떼어내는가]
// events-tab.js는 브라우저용 전역 스크립트라 module.exports가 없다. 다른 테스트
// (issue-text/expected-count)와 같은 방식으로 소스에서 해당 구간만 꺼내 실행한다.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "manager", "js", "events-tab.js");

// 업로드된 경로를 기록하는 storage 스텁
const puts = [];
const storage = {
  ref(p) {
    return {
      put: async () => { puts.push(p); },
      getDownloadURL: async () => `https://example.test/${p}?token=${puts.length}`,
    };
  },
};
let savedPatch = null;
const db = { collection: () => ({ doc: () => ({ update: async patch => { savedPatch = patch; } }) }) };
const firebase = { firestore: { FieldValue: { serverTimestamp: () => "TS" } } };

function loadHelpers() {
  const src = fs.readFileSync(SRC, "utf8");
  const start = src.indexOf("const MAX_DONE_PHOTOS");
  const end = src.indexOf("function setDonePhotoMsg");
  if (start < 0 || end < 0) {
    throw new Error("events-tab.js에서 완료사진 헬퍼 구간을 찾지 못했습니다 — 소스 구조가 바뀌었는지 확인하세요.");
  }
  const snippet = src.slice(start, end);
  const factory = new Function("storage", "db", "firebase",
    `${snippet}; return { MAX_DONE_PHOTOS, uploadDonePhotos, saveDonePhotoUrls };`);
  return factory(storage, db, firebase);
}

const { MAX_DONE_PHOTOS, uploadDonePhotos, saveDonePhotoUrls } = loadHelpers();

let failed = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`      got : ${g}`); console.log(`      want: ${w}`); }
}

const EV = () => ({ id: "log_ABC", center_name: "본사" });
const blobs = n => Array(n).fill("blob");

(async () => {
  eq("보고서 완료사진 열이 2개이므로 상한도 2", MAX_DONE_PHOTOS, 2);

  // ── 처음 2장 올리기 ────────────────────────────────────────────────
  puts.length = 0;
  let ev = EV();
  let urls = await uploadDonePhotos(ev, blobs(2), 0);
  eq("경로는 {eventId}_{1-based 순번}.jpg — 순번이 곧 J·K 자리",
    puts, ["completion_photos/본사/log_ABC_1.jpg", "completion_photos/본사/log_ABC_2.jpg"]);
  await saveDonePhotoUrls(ev, urls, 0);
  eq("문서에 2장이 순서대로 저장된다", ev.completion_photos.length, 2);
  eq("저장 필드 이름", Object.keys(savedPatch).sort(), ["completion_photos", "updated_at"]);

  // ── 1장 있는 상태에서 1장 추가 (startIndex = 기존 장수) ─────────────
  puts.length = 0;
  ev = { ...EV(), completion_photos: ["OLD1"] };
  urls = await uploadDonePhotos(ev, blobs(1), 1);
  eq("추가 업로드는 2번 자리에 올라간다(1번을 덮지 않는다)",
    puts, ["completion_photos/본사/log_ABC_2.jpg"]);
  await saveDonePhotoUrls(ev, urls, 1);
  eq("기존 1번 사진이 그대로 남는다", ev.completion_photos[0], "OLD1");
  eq("새 사진은 2번 자리", ev.completion_photos.length, 2);

  // ── 꽉 찬 상태에서 교체 (startIndex = 0) ───────────────────────────
  puts.length = 0;
  ev = { ...EV(), completion_photos: ["OLD1", "OLD2"] };
  urls = await uploadDonePhotos(ev, blobs(2), 0);
  eq("교체는 1번 자리부터 같은 경로에 덮어쓴다",
    puts, ["completion_photos/본사/log_ABC_1.jpg", "completion_photos/본사/log_ABC_2.jpg"]);
  await saveDonePhotoUrls(ev, urls, 0);
  eq("교체 후 옛 URL은 남지 않는다",
    ev.completion_photos.some(u => String(u).startsWith("OLD")), false);

  // ── 1장만 교체하면 2번은 유지 ───────────────────────────────────────
  ev = { ...EV(), completion_photos: ["OLD1", "OLD2"] };
  await saveDonePhotoUrls(ev, ["NEW1"], 0);
  eq("1번만 교체하면 2번은 그대로", ev.completion_photos, ["NEW1", "OLD2"]);

  // ── 상한 초과 방지 ─────────────────────────────────────────────────
  ev = { ...EV(), completion_photos: ["OLD1", "OLD2"] };
  await saveDonePhotoUrls(ev, ["X", "Y"], 2);
  eq("상한을 넘겨 저장해도 배열은 2장으로 잘린다", ev.completion_photos.length, MAX_DONE_PHOTOS);

  console.log(failed === 0 ? "\n모든 케이스 통과" : `\n${failed}건 실패`);
  process.exit(failed === 0 ? 0 : 1);
})();

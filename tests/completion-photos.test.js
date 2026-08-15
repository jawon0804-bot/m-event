// tests/completion-photos.test.js
// 완료 사진 초안(draft) → 저장 반영 규칙을 고정한다.
//
// 실행:
//   node tests/completion-photos.test.js
//
// [왜 이 테스트가 있는가]
// 완료 사진은 화면에서 고르고 X로 빼는 초안을 만든 뒤, [완료 처리]나 [첨부 완료]를 누를 때
// 한 번에 반영된다. 이 반영 로직이 틀어지면 증상이 전부 "조용한" 형태로 나온다:
//   · 남겨둔 사진이 사라지거나, 뺀 사진이 그대로 남는다
//   · **새로 올린 파일이 남아 있는 사진의 파일을 덮어써서**, 그 사진의 URL까지 죽는다
//     (덮어쓰면 GCS가 메타데이터를 교체해 Firebase 다운로드 토큰이 새로 발급되기 때문 —
//      화면·보고서에는 깨진 이미지로만 보이고 에러는 안 난다)
// 마지막 항목 때문에 2026-08-15에 파일명을 자리 번호(_1/_2)에서 시각+난수로 바꿨다.
// 아래 "덮어쓰지 않는다" 케이스가 그 결정을 지킨다.
//
// [왜 require 대신 소스에서 함수를 떼어내는가]
// events-tab.js는 브라우저용 전역 스크립트라 module.exports가 없다. 다른 테스트
// (issue-text/expected-count)와 같은 방식으로 소스에서 해당 구간만 꺼내 실행한다.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "manager", "js", "events-tab.js");

// ── 브라우저/Firebase 스텁 ──────────────────────────────────────────────
// put()은 실제 SDK처럼 스냅샷을 돌려준다(snap.ref.getDownloadURL()로 이어지는 형태).
// 업로드 직후 그 참조에서 URL을 받아야 덮어쓴 경우의 새 토큰이 반영된다.
const puts = [];
const storage = {
  ref(p) {
    const ref = { getDownloadURL: async () => `https://fs.test/${p}?token=t${puts.length}` };
    ref.put = async () => { puts.push(p); return { ref }; };
    return ref;
  },
};
let savedPatch = null;
const db = { collection: () => ({ doc: () => ({ update: async patch => { savedPatch = patch; } }) }) };
const firebase = { firestore: { FieldValue: { serverTimestamp: () => "TS" } } };
const URLStub = { createObjectURL: () => "blob:preview", revokeObjectURL: () => {} };

function loadHelpers() { return loadHelpersWith(storage); }

function loadHelpersWith(storageImpl) {
  const src = fs.readFileSync(SRC, "utf8");
  const start = src.indexOf("const MAX_DONE_PHOTOS");
  const end = src.indexOf("function renderModalPhotos");
  if (start < 0 || end < 0) {
    throw new Error("events-tab.js에서 완료사진 헬퍼 구간을 찾지 못했습니다 — 소스 구조가 바뀌었는지 확인하세요.");
  }
  const snippet = src.slice(start, end);
  const factory = new Function("storage", "db", "firebase", "URL", "renderModalPhotos", "showToast",
    `${snippet};
     return {
       MAX_DONE_PHOTOS, uploadDonePhotos, resolveDraftUrls, commitDoneDraft, isDoneDraftDirty,
       resetDoneDraft, removeDonePhoto,
       getDraft: () => doneDraft, setDraft: d => { doneDraft = d; },
     };`);
  return factory(storageImpl, db, firebase, URLStub, () => {}, () => {});
}

const H = loadHelpers();

let failed = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`      got : ${g}`); console.log(`      want: ${w}`); }
}

const EV = extra => ({ id: "log_ABC", center_name: "본사", ...extra });
const NEW = () => ({ kind: "new", blob: "blob", previewUrl: "blob:preview" });
const SAVED = url => ({ kind: "saved", url });

(async () => {
  eq("보고서 완료사진 열이 2개이므로 상한도 2", H.MAX_DONE_PHOTOS, 2);

  // ── 파일명: 자리 번호로 덮어쓰지 않는다 ─────────────────────────────
  puts.length = 0;
  let ev = EV();
  await H.uploadDonePhotos(ev, ["b1", "b2"]);
  eq("한 번에 올린 2장은 서로 다른 파일", new Set(puts).size, 2);
  const first = [...puts];
  await H.uploadDonePhotos(ev, ["b3"]);
  eq("나중에 올린 파일은 앞서 올린 파일과 겹치지 않는다(덮어쓰기 금지)",
    first.includes(puts[puts.length - 1]), false);
  eq("경로 규칙", /^completion_photos\/본사\/log_ABC_[0-9a-z]+_1\.jpg$/.test(first[0]), true);

  // ── 병렬 업로드 (회귀 방지) ─────────────────────────────────────────
  // 순차로 되돌아가도 결과는 같아서 테스트가 안 잡힌다. 그런데 이 버킷은 US-CENTRAL1이라
  // 왕복 비용이 지배적이고(M-SMART 실측: 장당 4~5초, 파일이 134~455KB인데도),
  // 순차면 그 시간이 장수만큼 그대로 곱해진다. 동시 실행 여부로 확인한다.
  {
    let inFlight = 0, maxInFlight = 0;
    const slowStorage = {
      ref(p) {
        const ref = { getDownloadURL: async () => `https://fs.test/${p}` };
        ref.put = async () => {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise(r => setTimeout(r, 20));
          inFlight--;
          return { ref };
        };
        return ref;
      },
    };
    const H2 = loadHelpersWith(slowStorage);
    await H2.uploadDonePhotos(EV(), ["b1", "b2"]);
    eq("2장을 동시에 올린다(순차로 되돌아가면 1)", maxInFlight, 2);
  }

  // ── resolveDraftUrls는 문서를 쓰지 않는다 ───────────────────────────
  // 완료 처리 흐름이 상태 변경과 사진을 **문서 쓰기 한 번**으로 합칠 수 있으려면,
  // URL을 만드는 단계에서 문서를 건드리면 안 된다.
  savedPatch = null;
  H.setDraft([NEW()]);
  await H.resolveDraftUrls(EV());
  eq("URL만 만들고 문서는 안 쓴다", savedPatch, null);

  // ── 초안 반영: 기존 유지 + 새로 올린 것 ─────────────────────────────
  puts.length = 0;
  ev = EV({ completion_photos: ["SAVED_A"] });
  H.setDraft([SAVED("SAVED_A"), NEW()]);
  let r = await H.commitDoneDraft(ev);
  eq("기존 1장은 그대로 두고 새 1장만 올린다", puts.length, 1);
  eq("순서는 초안 순서 그대로", ev.completion_photos[0], "SAVED_A");
  eq("총 2장", r.total, 2);
  eq("저장 필드", Object.keys(savedPatch).sort(), ["completion_photos", "updated_at"]);
  eq("저장 후 초안은 전부 saved로 바뀐다", H.getDraft().every(d => d.kind === "saved"), true);

  // ── X로 뺀 사진은 문서에서 빠진다 ───────────────────────────────────
  puts.length = 0;
  ev = EV({ completion_photos: ["SAVED_A", "SAVED_B"] });
  H.resetDoneDraft(ev);
  H.removeDonePhoto(0);                       // 1번 사진에 X
  await H.commitDoneDraft(ev);
  eq("X로 뺀 사진은 문서에서 사라진다", ev.completion_photos, ["SAVED_B"]);
  eq("남은 사진은 다시 올리지 않는다(업로드 0건)", puts.length, 0);

  // ⭐ 회귀 방지 핵심: 하나를 빼고 새로 한 장을 넣어도, 남아 있는 사진의 파일을 안 건드린다.
  //   예전 방식(자리 번호 파일명)이면 새 사진이 _1.jpg로 올라가 남은 사진 파일을 덮어썼다.
  puts.length = 0;
  ev = EV({ completion_photos: ["https://fs.test/completion_photos/본사/log_ABC_old_2.jpg?token=t9"] });
  H.setDraft([SAVED(ev.completion_photos[0]), NEW()]);
  await H.commitDoneDraft(ev);
  eq("새 파일이 남아 있는 사진의 파일 경로와 겹치지 않는다",
    puts.some(p => p.includes("log_ABC_old_2")), false);

  // ── 전부 빼면 빈 배열로 저장 ────────────────────────────────────────
  ev = EV({ completion_photos: ["SAVED_A", "SAVED_B"] });
  H.setDraft([]);
  await H.commitDoneDraft(ev);
  eq("전부 X 하면 빈 배열", ev.completion_photos, []);

  // ── 상한 ────────────────────────────────────────────────────────────
  ev = EV();
  H.setDraft([NEW(), NEW(), NEW()]);
  await H.commitDoneDraft(ev);
  eq("상한을 넘겨도 2장까지만 저장", ev.completion_photos.length, H.MAX_DONE_PHOTOS);

  // ── 저장 버튼 활성화 판정 ───────────────────────────────────────────
  ev = EV({ completion_photos: ["A", "B"] });
  H.resetDoneDraft(ev);
  eq("초안이 저장 상태와 같으면 dirty 아님", H.isDoneDraftDirty(ev), false);
  H.removeDonePhoto(1);
  eq("한 장 빼면 dirty", H.isDoneDraftDirty(ev), true);
  H.resetDoneDraft(ev);
  H.setDraft([SAVED("B"), SAVED("A")]);
  eq("순서만 바뀌어도 dirty", H.isDoneDraftDirty(ev), true);
  H.setDraft([SAVED("A"), SAVED("B"), NEW()]);
  eq("새로 고른 게 있으면 dirty", H.isDoneDraftDirty(ev), true);

  console.log(failed === 0 ? "\n모든 케이스 통과" : `\n${failed}건 실패`);
  process.exit(failed === 0 ? 0 : 1);
})();

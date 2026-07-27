// ── Firebase ──
const firebaseConfig = {
  apiKey:            "AIzaSyCgSuudB0Fax1ONAYHJwwYv99nhGAHIbO0",
  authDomain:        "m-smart-90148.firebaseapp.com",
  projectId:         "m-smart-90148",
  storageBucket:     "m-smart-90148.firebasestorage.app",
  messagingSenderId: "267082158406",
  appId:             "1:267082158406:web:eba0f68dde60931aea9547",
};
firebase.initializeApp(firebaseConfig);
const db        = firebase.firestore();
const storage   = firebase.storage();
const auth      = firebase.auth();
const functions = firebase.app().functions("asia-northeast3"); // 리전 미지정 시 us-central1로 감 — 이 프로젝트 함수는 전부 asia-northeast3에 배포됨

// ── 상태 ──
let currentUser  = null;
let allEvents    = [];
let fidLocations = {};
let sheetLabels  = {};
let eventTab     = "진행중";
let currentPage  = "event";
let currentEvent = null;
let unsubscribe  = null;

// ── 페이지네이션 상태 ──
const PAGE_SIZE = 30;
let eventPage = 1, excelPage = 1, photoPage = 1;

// ── 엑셀 탭 병합 선택 상태 ──
// excelDocs: 현재 조회 결과 전체(페이지네이션 이전). "전체 선택"이 화면에 보이는 30건이
//            아니라 조회된 전부를 대상으로 하려면 목록 전체를 들고 있어야 한다.
// excelSelectedIds: 체크된 문서 ID. 페이지를 넘겨도 선택이 유지되도록 목록과 분리해서 관리.
let excelDocs = [];
let excelSelectedIds = new Set();


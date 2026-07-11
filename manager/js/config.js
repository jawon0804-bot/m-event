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


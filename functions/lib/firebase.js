// lib/firebase.js
// Firebase Admin 초기화 + 공유 시크릿 정의를 한 곳으로 모아 어떤 모듈이 먼저
// require되든 admin.initializeApp()이 정확히 한 번만 실행되도록 보장한다.
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const bucket = admin.storage().bucket();

setGlobalOptions({ region: "asia-northeast3" });

const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_PASS = defineSecret("GMAIL_PASS");

module.exports = { admin, db, bucket, GMAIL_USER, GMAIL_PASS };

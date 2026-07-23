/**
 * Firebase Functions (2nd Gen) - M-Event 이슈 트래커 + 근무일지
 *
 * [트리거/스케줄]
 *   onInspectionLog        : inspection_logs 문서 생성/수정 시 memo 필드 감지 → events 생성 + 메일
 *   onIssueUpdate          : events 문서 status 변경 시 → 조치/완료 메일
 *   issueReminderScheduler : 매일 09:00 (Asia/Seoul) — 3일 이상 미조치 이벤트 재알림
 *   workLogDailyExport     : 매일 09:00 (Asia/Seoul) — 방금 끝난 근무일(어제 09:00~오늘 09:00)의
 *                            work_logs 데이터를, Storage의 센터별 원본 양식
 *                            (templates/{center}/work_log.xlsx, 시트 "양식")을 복제해
 *                            센터별 월별 엑셀 파일(work_log/{center}/...)에 날짜 시트로 반영
 *   workLogDailyInit       : 매일 09:00 (Asia/Seoul) — 출근부 템플릿으로 근무일지 기본값 자동 채움
 *   loginWithCredentials   : 이름+전화번호 로그인 (M-SMART/Dashboard도 공유해서 씀)
 *   generateEventReport    : 보고서 탭 "매핑" 버튼(Callable) — 센터/상태/기간(최대 1년) 필터로
 *                            events → Storage 템플릿(templates/report/event.xlsx)에 매핑,
 *                            report/{center}/{start}~{end}_매핑.xlsx 로 저장
 *   eventReportMonthlyExport : 매달 1일 00:00 (Asia/Seoul) — 필터 없이 전월 전체를 센터별로
 *                            report/{center}/{y}년_{m}월_이벤트보고서.xlsx 로 자동 저장
 *   listEventReportFiles   : 보고서 탭 "다운로드" 버튼(Callable) — report/{center}/ 파일 목록 +
 *                            서명 URL(10분 유효) 반환
 *
 * [배포]
 *   firebase deploy --only functions:onInspectionLog,functions:onIssueUpdate,functions:issueReminderScheduler,functions:workLogDailyExport,functions:generateEventReport,functions:eventReportMonthlyExport,functions:listEventReportFiles
 *   (firebase deploy --only functions 전체 배포 금지 — 같은 프로젝트의 별도 모니터링 함수와
 *    codebase가 분리되어 있어 구조적으로는 안전하지만, 안전을 위해 항상 함수명 지정)
 *
 * [환경변수/시크릿]
 *   GMAIL_USER, GMAIL_PASS — Secret Manager(defineSecret)로만 관리. 평문 .env 파일 절대 병행 금지.
 *
 * [2026-07-11] 950줄이던 이 파일을 config/lib로 분리했다 (Dashboard 리팩토링과 동일 패턴).
 *   config/constants.js — 근무일지 좌표, 출근부 코드맵, 로그인 잠금 설정, 이벤트 보고서 좌표
 *   lib/firebase.js      — admin 초기화 + 공유 시크릿(GMAIL_USER/PASS) 정의
 *   lib/mail.js           — 이메일 발송 유틸
 *   lib/dateUtils.js       — KST 날짜 파싱
 *   lib/events.js           — onInspectionLog / onIssueUpdate / issueReminderScheduler
 *   lib/worklog-export.js    — workLogDailyExport (근무일지 → 엑셀)
 *   lib/worklog-attendance.js — workLogDailyInit (출근부 → 근무일지 자동 채움)
 *   lib/auth.js               — loginWithCredentials
 *   lib/report-export.js       — generateEventReport / eventReportMonthlyExport / listEventReportFiles
 */

const events = require("./lib/events");
const worklogExport = require("./lib/worklog-export");
const worklogAttendance = require("./lib/worklog-attendance");
const auth = require("./lib/auth");
const reportExport = require("./lib/report-export");

exports.onInspectionLog = events.onInspectionLog;
exports.onIssueUpdate = events.onIssueUpdate;
exports.issueReminderScheduler = events.issueReminderScheduler;
exports.workLogDailyExport = worklogExport.workLogDailyExport;
exports.workLogDailyInit = worklogAttendance.workLogDailyInit;
exports.loginWithCredentials = auth.loginWithCredentials;
exports.generateEventReport = reportExport.generateEventReport;
exports.eventReportMonthlyExport = reportExport.eventReportMonthlyExport;
exports.listEventReportFiles = reportExport.listEventReportFiles;

// اختبار ضغط (k6): يصل تدريجياً إلى 1000 مستخدم افتراضي على قراءات التطبيق.
// تحذير: شغّله على مشروع Supabase تجريبي فقط، لا على الإنتاج.
// التشغيل:
//   k6 run -e SUPABASE_URL=https://xxxx.supabase.co -e ANON_KEY=sb_publishable_... \
//          -e TEST_EMAIL=test@example.com -e TEST_PASSWORD=... -e ORG_ID=<uuid> scripts/load_test.k6.js
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 100 },
    { duration: "3m", target: 500 },
    { duration: "3m", target: 1000 },
    { duration: "2m", target: 1000 },
    { duration: "1m", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],       // أقل من 1% أخطاء
    http_req_duration: ["p(95)<800"],     // 95% من الطلبات أقل من 800ms
  },
};

const URL = __ENV.SUPABASE_URL;
const KEY = __ENV.ANON_KEY;
const ORG = __ENV.ORG_ID;

// تسجيل دخول واحد فقط: تسجيل 1000 دخول متزامن سيصطدم بحدود المصادقة وليس بحدود التطبيق.
export function setup() {
  const r = http.post(`${URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email: __ENV.TEST_EMAIL, password: __ENV.TEST_PASSWORD }),
    { headers: { apikey: KEY, "Content-Type": "application/json" } });
  check(r, { "login ok": (x) => x.status === 200 });
  return { token: r.json("access_token") };
}

export default function (data) {
  const h = { apikey: KEY, Authorization: `Bearer ${data.token}` };
  const q = `org_id=eq.${ORG}`;
  const calls = [
    `${URL}/rest/v1/accounts?select=*&${q}`,
    `${URL}/rest/v1/v_account_balances?select=*&${q}`,
    `${URL}/rest/v1/journal_entries?select=*&${q}&order=created_at.desc&limit=50`,
  ];
  for (const u of calls) {
    const res = http.get(u, { headers: h });
    check(res, { "status 200": (x) => x.status === 200 });
  }
  sleep(1 + Math.random() * 2);
}

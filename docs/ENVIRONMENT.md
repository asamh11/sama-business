# البيئة والإصدارات

| المكوّن | المطلوب | ملاحظة |
|---|---|---|
| Node.js | 22.18 أو أحدث (`.nvmrc`) | الاختبارات تشغَّل بـ type stripping دون بناء |
| TypeScript | 5.x (للفحص فقط) | `npx -p typescript tsc --noEmit` |
| Supabase CLI + Docker | أحدث نسخة | **سجّل الإصدار هنا بعد أول تشغيل ناجح** |
| PostgreSQL | 15 أو أحدث | مطلوب لـ `security_invoker` في الـ view |

## البيئات
- **local**: `supabase start` (تطوير واختبارات).
- **staging**: مشروع Supabase منفصل، تُجرَّب عليه كل migration قبل الإنتاج.
- **production**: لا تجارب عليه أبداً، ولا يُطبَّق عليه migration دون نجاح staging ونسخة احتياطية مجرَّبة.

## الفروع
`main` (مستقر) ← `development` (دمج العمل) ← `feature/*`. الوسم `v0.1` يحفظ الملف التأسيسي الأصلي دون تعديل.

## مراجعة تغييرات قاعدة البيانات
كل ملف في `supabase/migrations` يحتاج مراجعة شخص ثانٍ، ولا يُعدَّل بعد تطبيقه خارج جهازك؛ التعديل يكون بـ migration جديد.

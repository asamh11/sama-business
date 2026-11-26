// القائمة الرئيسية المقترحة (البند 9 من المواصفات) + أنماط الحساب (البند 1-3).
// status: "available" = وظيفة فعلية موجودة اليوم، "soon" = مخططة ولم تُبنَ بعد.

export type AccountMode = "personal" | "retail" | "enterprise";
export const ACCOUNT_MODES: AccountMode[] = ["personal", "retail", "enterprise"];

export type NavId =
  | "home" | "accounting" | "sales" | "purchases" | "inventory" | "contacts"
  | "cash" | "hr" | "branches" | "reports" | "ai" | "settings";

export type NavItem = {
  id: NavId;
  status: "available" | "soon";
  modes: AccountMode[];
};

const ALL: AccountMode[] = ["personal", "retail", "enterprise"];

export const NAV: NavItem[] = [
  { id: "home", status: "available", modes: ALL },
  { id: "accounting", status: "available", modes: ALL },
  { id: "sales", status: "soon", modes: ["retail", "enterprise"] },
  { id: "purchases", status: "soon", modes: ["retail", "enterprise"] },
  { id: "inventory", status: "soon", modes: ["retail", "enterprise"] },
  { id: "contacts", status: "soon", modes: ["retail", "enterprise"] },
  { id: "cash", status: "available", modes: ALL },
  { id: "hr", status: "soon", modes: ["enterprise"] },
  // الفروع مطلوبة لترحيل القيود والصناديق، لذا تظهر في كل الأنماط.
  { id: "branches", status: "available", modes: ALL },
  { id: "reports", status: "available", modes: ALL },
  { id: "ai", status: "soon", modes: ALL },
  { id: "settings", status: "available", modes: ALL },
];

export const navFor = (mode: AccountMode): NavItem[] => NAV.filter((n) => n.modes.includes(mode));

/** الأدوار التي تسمح لها قاعدة البيانات بكل عملية (للإخفاء في الواجهة فقط؛ الحماية الفعلية في SQL/RLS). */
export const CAN = {
  post: ["owner", "admin", "accountant", "cashier"],
  reverse: ["owner", "admin", "accountant"],
  closeBooks: ["owner", "admin"],
  redeem: ["owner", "admin"],
} as const;

export const roleAllows = (role: string | null, allowed: readonly string[]) => (role ? allowed.includes(role) : false);

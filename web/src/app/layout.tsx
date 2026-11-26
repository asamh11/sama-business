import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sama Business | سما بزنس",
  description: "نظام محاسبي سحابي متعدد الشركات والعملات",
  manifest: "./manifest.json",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}

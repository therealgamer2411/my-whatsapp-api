import "./globals.css";

export const metadata = {
  title: "سكرتير محمد | Media First",
  description: "لوحة التحكم الخاصة بالسكرتير الذكي للمهندس محمد عبداللاه",
  applicationName: "سكرتير محمد",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "سكرتير محمد"
  },
  formatDetection: { telephone: false }
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#f7f8fa"
};

export default function RootLayout({ children }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Next.js on CE",
  description: "Next.js static export on CE, persisted to ce.db",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#03060e" />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cg fill='none' stroke='%2337c6ff' stroke-width='2.4' stroke-linecap='round'%3E%3Cpath d='M4 12c3 0 3 3 6 3s3-3 6-3 3 3 6 3 3-3 6-3'/%3E%3Cpath d='M4 19c3 0 3 3 6 3s3-3 6-3 3 3 6 3 3-3 6-3'/%3E%3C/g%3E%3C/svg%3E"
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,600;1,600&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

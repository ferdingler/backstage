import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Backstage · Questions worth asking",
  description:
    "Ask a question, add your vote, and follow Backstage during the presentation.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

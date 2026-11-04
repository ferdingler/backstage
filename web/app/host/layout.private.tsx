import type { Metadata } from "next";

export const metadata: Metadata = { title: "Host" };

export default function HostLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}

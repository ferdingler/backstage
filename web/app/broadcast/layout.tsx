import type { Metadata } from "next";

export const metadata: Metadata = { title: "Broadcast" };

export default function BroadcastLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}

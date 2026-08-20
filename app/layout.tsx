import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const TITLE = "권역별 누적강수 현황";
const DESCRIPTION = "기상청 66개 대표지점의 누적강수량·평년값·평년비 조회";
const LOCAL_ORIGIN = new URL("http://localhost:3000");

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = firstHeader(requestHeaders.get("x-forwarded-host")) ?? firstHeader(requestHeaders.get("host"));
  const protocol = firstHeader(requestHeaders.get("x-forwarded-proto"));
  const origin = safeOrigin(host, protocol);
  const image = new URL("/og.png", origin).toString();
  return {
    metadataBase: origin,
    title: TITLE,
    description: DESCRIPTION,
    openGraph: { title: TITLE, description: DESCRIPTION, type: "website", images: [{ url: image, width: 1792, height: 909, alt: TITLE }] },
    twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [image] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

function firstHeader(value: string | null): string | null {
  return value?.split(",", 1)[0]?.trim() || null;
}

function safeOrigin(host: string | null, protocol: string | null): URL {
  if (!host) return LOCAL_ORIGIN;
  const scheme = protocol === "https" || protocol === "http" ? protocol : host.startsWith("localhost") ? "http" : "https";
  try {
    const origin = new URL(`${scheme}://${host}`);
    return origin.pathname === "/" && !origin.username && !origin.password ? origin : LOCAL_ORIGIN;
  } catch {
    return LOCAL_ORIGIN;
  }
}

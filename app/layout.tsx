import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${protocol}://${host}` : "https://video-manager.invalid";
  return {
    metadataBase: new URL(origin),
    title: {
      default: "视频素材管理器",
      template: "%s｜视频素材管理器",
    },
    description: "一处整理视频素材、封面和发布进度。",
    openGraph: {
      title: "视频素材管理器",
      description: "让每一条内容从素材到发布都有迹可循。",
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1731, height: 909 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "视频素材管理器",
      description: "让每一条内容从素材到发布都有迹可循。",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

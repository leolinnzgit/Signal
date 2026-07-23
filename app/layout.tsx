import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const themeBootstrap = `try{const s=localStorage.getItem("signal-color-theme");const t=s==="light"||s==="dark"?s:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}catch{}`;

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const description = "A configurable live briefing that gathers recent reporting on the topic you care about.";

  return {
    metadataBase: new URL(origin),
    title: "Signal — Your personal news monitor",
    description,
    openGraph: {
      title: "Signal — Stay current on what matters",
      description,
      url: origin,
      siteName: "Signal",
      type: "website",
      images: [{ url: `${origin}/og.png`, width: 1792, height: 934, alt: "Signal — Stay current on what matters" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Signal — Stay current on what matters",
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head>
      <body>{children}</body>
    </html>
  );
}

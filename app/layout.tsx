import type { Metadata } from "next";
import { geistSans, geistMono, plotFont } from "./fonts";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "PHI Forecast Graphics | 3-Day Weather Forecasts",
    description: "Continuously updated Day 1–3 temperature, apparent temperature, wind gust, precipitation probability, and precipitation graphics for the PHI forecast area.",
    openGraph: { title: "PHI Forecast Graphics", description: "Three-day graphics for the PHI forecast area." },
    twitter: { card: "summary", title: "PHI Forecast Graphics", description: "Three-day graphics for the PHI forecast area." },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable} ${plotFont.variable}`}>{children}</body></html>;
}

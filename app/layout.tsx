import type { Metadata } from "next";
import { geistSans, geistMono, plotFont } from "./fonts";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "PHI Forecast Graphics | Day 1 Weather Forecasts",
    description: "Continuously updated temperature, apparent temperature, wind gust, precipitation probability, and precipitation graphics for the NWS Philadelphia / Mount Holly forecast area.",
    openGraph: { title: "PHI Forecast Graphics", description: "Day 1 forecast graphics for Philadelphia / Mount Holly." },
    twitter: { card: "summary", title: "PHI Forecast Graphics", description: "Day 1 forecast graphics for Philadelphia / Mount Holly." },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable} ${plotFont.variable}`}>{children}</body></html>;
}

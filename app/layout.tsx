import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "leaflet/dist/leaflet.css";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "PHI Forecast Graphics | Maximum Apparent Temperature",
    description: "Continuously updated apparent-temperature forecast graphics for the NWS Philadelphia / Mount Holly forecast area.",
    openGraph: { title: "PHI Forecast Graphics", description: "Maximum apparent-temperature forecasts for Philadelphia / Mount Holly." },
    twitter: { card: "summary", title: "PHI Forecast Graphics", description: "Maximum apparent-temperature forecasts for Philadelphia / Mount Holly." },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}

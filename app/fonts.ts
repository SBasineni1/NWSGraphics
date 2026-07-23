import { Geist, Geist_Mono, Barlow_Semi_Condensed } from "next/font/google";

export const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
export const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Condensed grotesque for the map plots — a cleaner, lighter alternative to Arial.
export const plotFont = Barlow_Semi_Condensed({ variable: "--font-plot", subsets: ["latin"], weight: ["500", "600", "700"] });
export const PLOT_FONT_FAMILY = plotFont.style.fontFamily;

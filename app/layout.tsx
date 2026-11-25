import type { Metadata } from "next";
import { geistSans, geistMono, plotFont } from "./fonts";
import { INTRO_SEEN_KEY } from "./intro-session";
import "./globals.css";

// The weather intro is in the server HTML so a first visit sees it from the very first paint.
// This runs before paint and hides it for a session that has already dismissed it — reading
// the flag after hydration instead would flash the intro on every reload. Storage can throw
// (disabled, some private modes); the intro then simply shows.
//
// It also carries a fallback dismissal. Until WeatherIntro hydrates and sets
// `data-intro-live`, React's handlers are not attached, so on a slow connection — or if the
// bundle never runs at all — the "click anywhere" prompt would invite clicks that do nothing.
// The fallback hides the overlay through the same `data-intro="seen"` rule and remembers it.
const KEY = JSON.stringify(INTRO_SEEN_KEY);
const INTRO_SEEN_SCRIPT = `(function(){var d=document.documentElement,s;try{s=sessionStorage.getItem(${KEY})}catch(e){}`
  + `if(s){d.dataset.intro="seen";return}`
  + `function f(e){if(d.dataset.introLive||d.dataset.intro)return;`
  + `if(e.type==="keydown"&&e.key!=="Enter"&&e.key!=="Escape"&&e.key!==" ")return;`
  + `d.dataset.intro="seen";try{sessionStorage.setItem(${KEY},"1")}catch(x){}}`
  + `document.addEventListener("pointerdown",f);document.addEventListener("keydown",f)})()`;

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "NWS Graphics | 3-Day Weather Forecasts",
    description: "Continuously updated Day 1–3 temperature, apparent temperature, wind gust, precipitation probability, and precipitation graphics for National Weather Service forecast offices nationwide.",
    openGraph: { title: "NWS Graphics", description: "Three-day forecast graphics for National Weather Service offices nationwide." },
    twitter: { card: "summary", title: "NWS Graphics", description: "Three-day graphics for National Weather Service offices nationwide." },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The intro script sets data-intro on <html> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: INTRO_SEEN_SCRIPT }} />
        {/* Without JavaScript nothing could dismiss the intro, so it never shows. */}
        <noscript><style>{".weather-intro{display:none}"}</style></noscript>
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} ${plotFont.variable}`}>{children}</body>
    </html>
  );
}

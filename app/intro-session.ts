// Shared by layout.tsx (a server component, which renders the pre-paint script) and
// WeatherIntro.tsx (a client component, which writes the flag). It lives in neither: a
// server component importing a value from a "use client" module gets a client reference,
// not the value, and the script would read sessionStorage.getItem(undefined).

/** sessionStorage key marking that this session has seen (and dismissed) the intro. */
export const INTRO_SEEN_KEY = "nws-intro-seen";

import type { Config } from "tailwindcss";

// Manuscript design system — tokens extracted from the reference landing
// page (reviewarena-landing.html). Single light theme; colors are static
// hexes so Tailwind opacity modifiers work. The shadcn names (background,
// primary, muted…) are kept as aliases so existing components resolve.
const paper = "#faf9f5";
const paper2 = "#f3f1ea";
const ink = "#191815";
const ink2 = "#2b2926";
const graphite = "#6d685f";
const rule = "#ddd8cc";
const rule2 = "#c9c3b4";
const red = "#9d2b22";
const redink = "#7a2019";
const up = "#3a6349";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem", screens: { "2xl": "1400px" } },
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', "system-ui", "-apple-system", "sans-serif"],
        serif: ['"IBM Plex Serif"', "Georgia", "serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        // Named reference tokens
        paper,
        paper2,
        ink,
        ink2,
        graphite,
        rule,
        rule2,
        red,
        redink,
        up,
        // shadcn aliases
        border: rule,
        input: rule2,
        ring: red,
        background: paper,
        foreground: ink,
        primary: { DEFAULT: red, foreground: paper },
        secondary: { DEFAULT: paper2, foreground: ink },
        muted: { DEFAULT: paper2, foreground: graphite },
        accent: { DEFAULT: paper2, foreground: ink },
        destructive: { DEFAULT: red, foreground: paper },
        card: { DEFAULT: "#fdfcf9", foreground: ink },
      },
      borderRadius: { lg: "0", md: "0", sm: "0" },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;

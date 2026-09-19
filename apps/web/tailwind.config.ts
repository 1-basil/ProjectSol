import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        surface2: "rgb(var(--surface-2) / <alpha-value>)",
        border: {
          DEFAULT: "rgb(var(--border) / <alpha-value>)",
          strong: "rgb(var(--border-strong) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--text) / <alpha-value>)",
          muted: "rgb(var(--text-muted) / <alpha-value>)",
          faint: "rgb(var(--text-faint) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          2: "rgb(var(--accent-2) / <alpha-value>)",
        },
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      fontFeatureSettings: {
        tabular: '"tnum" 1, "cv11" 1',
      },
      borderRadius: {
        xl2: "1rem",
        xl3: "1.5rem",
      },
      boxShadow: {
        glow: "0 0 0 1px rgb(255 255 255 / 0.9), 0 8px 40px -8px rgb(var(--accent) / 0.55)",
        card: "0 1px 0 0 rgb(255 255 255 / 0.04) inset, 0 20px 60px -20px rgb(0 0 0 / 0.6)",
        elevated: "0 30px 80px -20px rgb(0 0 0 / 0.65)",
      },
      backgroundImage: {
        "grid-fade": "radial-gradient(ellipse 70% 45% at 50% -10%, rgb(var(--accent) / 0.22), transparent), radial-gradient(ellipse 40% 30% at 85% 10%, rgb(var(--accent-2) / 0.10), transparent)",
        "accent-gradient": "linear-gradient(90deg, rgb(var(--accent)), rgb(var(--accent-2)))",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-8px)" },
        },
        "gradient-move": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(14px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "ring-draw": {
          from: { strokeDashoffset: "283" },
          to: { strokeDashoffset: "0" },
        },
      },
      animation: {
        shimmer: "shimmer 2.4s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        "gradient-move": "gradient-move 6s ease infinite",
        "pulse-soft": "pulse-soft 2.4s ease-in-out infinite",
        "fade-up": "fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) both",
        "scale-in": "scale-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) both",
      },
      transitionTimingFunction: {
        premium: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};

export default config;

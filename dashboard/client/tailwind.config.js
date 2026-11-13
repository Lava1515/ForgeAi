/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Warm graphite neutrals (100 = bone text, 950 = page)
        ink: {
          50: '#F7F5F1', 100: '#EDE9E3', 200: '#D8D3CA', 300: '#B7B1A7', 400: '#8E8980',
          500: '#6A6660', 600: '#4A4743', 700: '#363431', 750: '#2E2C29', 800: '#272523', 850: '#1F1E1C', 900: '#181716', 950: '#0E0D0C',
        },
        // Molten accent — primary actions, active states, prices
        ember: {
          50: '#FFF3EC', 100: '#FFE2D1', 200: '#FFC2A1', 300: '#FF9A6B', 400: '#FF7740',
          500: '#FF5A1F', 600: '#E8430B', 700: '#C0340A', 800: '#992B0F', 900: '#7C2610', 950: '#431006',
        },
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}

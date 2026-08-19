/** @type {import('tailwindcss').Config} */
// Palette, type scale and elevation are lifted directly from the telephony-console mockup
// (Business-Platform-Design/artifacts/mockup-sandbox). That mockup keeps its whole design system
// inline as arbitrary Tailwind values rather than in a config, so the hex values below are the
// extracted source of truth - keeping them as named tokens means every page picks up the identity
// without repeating raw hexes everywhere.
export default {
  // Toggled via a `dark` class on <html> (see context/ThemeContext.jsx) rather than following
  // the OS preference, so the user's explicit choice always wins and persists across sessions.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Headings, metric values and anything numeric - the mockup pairs a geometric display
        // face against DM Sans for exactly these.
        display: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      colors: {
        // Teal - the mockup's single accent, used for active nav, links, primary fills and the
        // "answered/healthy" semantic across charts and pills.
        brand: {
          50: '#f0f7f5',
          100: '#e5f6f2',
          200: '#d8eeea',
          300: '#bfe9df',
          400: '#5fc4b6',
          500: '#168f84',
          600: '#0f7d73',
          700: '#0d7069',
          800: '#0c625b',
          900: '#154f4a'
        },
        // Coral - decorative/critical accents only (failed calls, destructive hints). Kept apart
        // from the semantic red-* classes so an accent never reads as an error state.
        coral: {
          50: '#ffebe5',
          100: '#f9d9d0',
          200: '#f4c6bb',
          300: '#e9a496',
          400: '#df775f',
          500: '#c25d4d',
          600: '#b34838',
          700: '#963a2d',
          800: '#7a2f25',
          900: '#5e241c'
        },
        // Amber - "needs attention" states: paused campaigns, low balance, degraded ports.
        gold: {
          50: '#fff8e9',
          100: '#fff4dc',
          200: '#f9dca5',
          300: '#f0d89f',
          400: '#e5b75d',
          500: '#d89534',
          600: '#c17820',
          700: '#9a6500',
          800: '#855d15',
          900: '#7f641e'
        },
        // Ink - text and the deep-teal surfaces the mockup uses for primary buttons, dark chart
        // panels and the sidebar. 900 is the near-black-teal the mockup calls its darkest surface.
        ink: {
          50: '#f1f5f2',
          100: '#e1ebe7',
          200: '#c9d8d4',
          300: '#a1afac',
          400: '#879591',
          500: '#738382',
          600: '#667976',
          700: '#49615d',
          800: '#2d4a4c',
          900: '#172d32'
        },
        // Named surfaces, so page chrome never hard-codes a hex. `deep` is the mockup's #173e42 -
        // its primary button fill and the ground behind its bar charts.
        canvas: '#f4f7f5',
        surface: '#fbfcfb',
        rail: '#eef4f1',
        topbar: '#f8faf8',
        line: '#dfe7e4',
        'line-strong': '#dce6e2',
        deep: '#173e42',
        // Dark-mode ramp. The mockup only styles its outer chrome for dark (#13282c page,
        // #183438 panels, #315052 borders) - this extends that same deep-teal family into a full
        // ramp so cards, tables and inputs all have a surface to sit on.
        abyss: {
          50: '#9db5b2',
          100: '#7d9995',
          200: '#5c7a78',
          300: '#3f5f60',
          400: '#264a4d',
          500: '#183438',
          600: '#152e31',
          700: '#13282c',
          800: '#0f2124',
          900: '#0b191b'
        },
        // Legible-on-dark accents. Named `neon` for continuity with the classes already spread
        // across the pages, but retuned to the mockup's teal family rather than an electric glow.
        neon: {
          cyan: '#5fd4c4',
          green: '#a8db4e',
          purple: '#9d94d8'
        }
      },
      boxShadow: {
        // The mockup's single card elevation - a very soft ink-tinted lift, not a grey drop.
        card: '0 5px 16px rgba(24,48,53,.035)',
        raise: '0 7px 18px rgba(23,62,66,.12)'
      }
    }
  },
  plugins: []
};

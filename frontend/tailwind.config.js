/** @type {import('tailwindcss').Config} */
export default {
  // Toggled via a `dark` class on <html> (see context/ThemeContext.jsx) rather than following
  // the OS preference, so the user's explicit choice always wins and persists across sessions.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Montserrat', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Used for dark-mode dashboard surfaces (see Dashboard.jsx) - reads as technical/modern,
        // matching the neon/glassmorphism reference brief. Light mode keeps plain Montserrat.
        display: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      colors: {
        // Dark-mode "analytical dashboard" accent palette - glowing electric cyan/purple/green
        // against deep near-black surfaces, per the neon/glassmorphism reference brief. Only
        // meant to be used behind dark: variants; the light theme never references these.
        neon: {
          cyan: '#00f0ff',
          purple: '#b026ff',
          green: '#00ff66'
        },
        // Deep dark surfaces for dark-mode backgrounds/panels (glassmorphism cards sit on top of
        // these with backdrop-blur + low-opacity fills).
        abyss: {
          50: '#8892a6',
          100: '#6b7690',
          200: '#4d5773',
          300: '#374057',
          400: '#252c3d',
          500: '#171c28',
          600: '#12151f',
          700: '#0d0f17',
          800: '#090a10',
          900: '#05060a'
        },
        // Teal - primary interactive color (buttons, links, focus rings) across the whole app.
        brand: {
          50: '#f0f7f6',
          100: '#dceeec',
          200: '#bfddd9',
          300: '#9cc9c3',
          400: '#7fb9b3',
          500: '#67b0ac',
          600: '#4e948f',
          700: '#3d7672',
          800: '#2e5a57',
          900: '#22423f'
        },
        // Coral - decorative accents/highlights only (live badges, tags). Kept separate from the
        // semantic red-* classes used for destructive actions so accents never read as "danger".
        coral: {
          50: '#fff1f1',
          100: '#ffe1e1',
          200: '#ffc7c7',
          300: '#ffa3a3',
          400: '#ff8080',
          500: '#ff6363',
          600: '#e84545',
          700: '#c22f2f',
          800: '#9c2626',
          900: '#7a1f1f'
        },
        // Ink - dark surfaces/text (sidebar, headings).
        ink: {
          50: '#f4f5f7',
          100: '#e4e6ea',
          200: '#c7cbd3',
          300: '#9fa5b2',
          400: '#6d7585',
          500: '#454d5e',
          600: '#323847',
          700: '#262b38',
          800: '#1f232e',
          900: '#19202b'
        }
      }
    }
  },
  plugins: []
};

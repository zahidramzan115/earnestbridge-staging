/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['Plus Jakarta Sans', 'sans-serif'],
        sans: ['DM Sans', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      },
      colors: {
        'eb-green': {
          950: '#060F0B',
          900: '#0D2B1F',
          800: '#1A4A35',
          700: '#226040',
          600: '#2D7A52',
          500: '#3A9966',
          400: '#5CB885',
          300: '#87CFA8',
          200: '#B8E5CC',
          100: '#E0F4EB',
          50:  '#F0FAF4',
        },
        'eb-gold': {
          900: '#5C3D10',
          800: '#7A5218',
          700: '#9A6A20',
          600: '#B8842C',
          500: '#C9A84C',
          400: '#D9BF78',
          300: '#E8D4A4',
          200: '#F2E8CC',
          100: '#FAF4E8',
        },
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgba(0,0,0,0.06), 0 1px 2px -1px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 12px 0 rgba(0,0,0,0.10), 0 2px 4px -1px rgba(0,0,0,0.06)',
        'modal': '0 20px 60px -10px rgba(0,0,0,0.25)',
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
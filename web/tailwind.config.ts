import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#132c45',
        muted: '#5a6d81',
        canvas: '#f3f6f9',
        signal: '#275cd7',
        teal: '#08786f',
        line: '#dfe7ef',
      },
      fontFamily: {
        display: ['Avenir Next', 'Segoe UI', 'Helvetica Neue', 'sans-serif'],
        sans: ['Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },
    },
  },
} satisfies Config

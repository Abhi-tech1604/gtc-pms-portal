/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0f172a',
        rig: {
          50: '#eef4ff', 100: '#dae5ff', 200: '#bccffe', 300: '#8faefc',
          400: '#5b83f8', 500: '#365df0', 600: '#2340e0', 700: '#1c33bd',
          800: '#1c2e9a', 900: '#1c2b7a',
        },
      },
      keyframes: {
        floatY: {
          '0%, 100%': { transform: 'translateY(0px) translateX(0px)' },
          '50%': { transform: 'translateY(-20px) translateX(6px)' },
        },
        glowPulse: {
          '0%, 100%': { opacity: '0.35', transform: 'scale(1)' },
          '50%': { opacity: '0.6', transform: 'scale(1.1)' },
        },
        cardIn: {
          '0%': { opacity: '0', transform: 'translateY(28px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        drawLine: {
          '0%': { strokeDashoffset: '600' },
          '100%': { strokeDashoffset: '0' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        float: 'floatY 6s ease-in-out infinite',
        'float-slow': 'floatY 9s ease-in-out infinite',
        'float-slower': 'floatY 13s ease-in-out infinite',
        glow: 'glowPulse 7s ease-in-out infinite',
        'card-in': 'cardIn 0.8s cubic-bezier(0.16,1,0.3,1) both',
        'fade-in': 'fadeIn 0.6s ease-out both',
        draw: 'drawLine 2.6s ease-out forwards',
        shimmer: 'shimmer 3.5s linear infinite',
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        docs: '#2E6450',
        ink: '#111111'
      },
      fontFamily: {
        brand: ['Bungee', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      boxShadow: {
        card: '0 18px 60px rgba(20, 27, 24, 0.12)'
      }
    }
  },
  plugins: []
};

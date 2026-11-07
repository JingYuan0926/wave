// Root code reads this one public value. vite.config.ts replaces it at build time.
declare const process: { env: { NEXT_PUBLIC_WAVE_MOCK?: string } };

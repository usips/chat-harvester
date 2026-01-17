import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['test/**/*.test.{js,ts}'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/**/*.{js,ts}'],
        },
        globals: true,
    },
    resolve: {
        alias: {
            '@core': '/src/core',
            '@platforms': '/src/platforms',
        },
    },
});

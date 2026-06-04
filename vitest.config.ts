import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        include: ["dist/tests/**/*.test.js"],
    },
})

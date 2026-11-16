// @ts-check
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// https://astro.build/config
export default defineConfig({
  output: "server",
  vite: {
    build: { sourcemap: "hidden" },
    plugins: [
      tailwindcss(),
      sentryVitePlugin({
        disable:
          !process.env.SENTRY_AUTH_TOKEN || !process.env.SENTRY_ORG || !process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        release: { name: process.env.SENTRY_RELEASE, create: false, finalize: false },
        telemetry: false,
        sourcemaps: { filesToDeleteAfterUpload: ["./dist/client/**/*.map"] },
      }),
    ],
  },
});

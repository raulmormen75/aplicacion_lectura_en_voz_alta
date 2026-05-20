import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  turbopack: {
    resolveAlias: {
      crypto: {
        browser: "./src/lib/empty-module.ts",
      },
      fs: {
        browser: "./src/lib/empty-module.ts",
      },
      path: {
        browser: "./src/lib/empty-module.ts",
      },
    },
  },
  outputFileTracingIncludes: {
    "/api/documents/process": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;

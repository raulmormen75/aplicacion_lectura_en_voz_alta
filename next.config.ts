import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";
// The static Next/PWA shell needs its inline bootstrap and React style props.
// CDN access is restricted to the existing OCR/Piper JS and WASM resources.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' blob: https://cdn.jsdelivr.net 'unsafe-inline' 'wasm-unsafe-eval'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  `connect-src 'self' https://cdn.jsdelivr.net${isDevelopment ? " ws: wss:" : ""}`,
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(!isDevelopment ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  devIndicators: false,
  headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), fullscreen=(self)" },
      ],
    }];
  },
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

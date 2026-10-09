import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./reader-book.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "En voz",
  description: "Escucha documentos, textos y sitios web con tu avance guardado en este dispositivo.",
  icons: { icon: "/icons/en-voz-192.png", apple: "/icons/en-voz-192.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "En voz",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es-MX"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

import React from 'react';
import type { Metadata, Viewport } from 'next';
import '../styles/tailwind.css';
import { AuthProvider } from '@/contexts/AuthContext';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'EarnestBridge — EMD Financing for CRE Deals',
  description: 'Track your earnest money deposit financing applications, manage documents, and monitor closing timelines from a single borrower dashboard.',
  icons: {
    icon: [{ url: '/favicon.ico', type: 'image/x-icon' }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        {/* Bullseye Pixel */}
        <script async defer src="https://script.bullseye.so/script/ef9750e2-1a05-44fe-92af-f0ddceb51776" referrerPolicy="strict-origin-when-cross-origin" data-bullseye-pixel="ef9750e2-1a05-44fe-92af-f0ddceb51776"></script>

        <script type="module" async src="https://static.rocket.new/rocket-web.js?_cfg=https%3A%2F%2Fearnestbri3677back.builtwithrocket.new&_be=https%3A%2F%2Fappanalytics.rocket.new&_v=0.1.21" />
        <script type="module" defer src="https://static.rocket.new/rocket-shot.js?v=0.0.3" /></head>
      <body className="font-sans antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
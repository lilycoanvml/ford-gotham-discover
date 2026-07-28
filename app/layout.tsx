import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Discover Your Next You',
  description:
    'In five years, who will you be? Tell us your vision, and we’ll show you the vehicle built to take you there. A guided moment of self-discovery.',
  openGraph: {
    title: 'Discover Your Next You',
    description: 'In five years, who will you be? A guided moment of self-discovery.',
    siteName: 'Discover Your Next You',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* PLACEHOLDER TYPE: Ford Antenna is licensed and NOT bundled. Archivo +
            Space Mono stand in for the display/mono roles until the licensed
            Antenna webfont is loaded. Swap per Ford RSF before external use. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

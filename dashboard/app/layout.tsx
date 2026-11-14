import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Instrument_Sans, Instrument_Serif } from 'next/font/google';
import './globals.css';
import { INTRO_BOOT_SCRIPT } from '@/lib/intro';

// Self-hosted at build time by next/font: the interface face, the tabular face every number is set in,
// and the display face used only for workspace titles.
const sans = Instrument_Sans({ subsets: ['latin'], display: 'swap', variable: '--font-sans' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap', variable: '--font-mono' });
const serif = Instrument_Serif({ subsets: ['latin'], weight: '400', display: 'swap', variable: '--font-serif' });

const TITLE = 'QuantCore — Options Pricing & Risk Research Terminal';
const DESCRIPTION =
  'Build option strategies, compare Black-Scholes, binomial and Monte Carlo pricing, ' +
  'simulate GBM paths, stress-test portfolios and measure VaR. Browser analytics plus a ' +
  'local C++17 / Apple Metal pricing engine over WebSocket.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  authors: [{ name: 'Gaurang Khurana', url: 'https://gaurangkhurana.ca' }],
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website' },
};

export const viewport: Viewport = {
  themeColor: '#0a0b0d',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the script below sets data-intro on <html> before React hydrates (see lib/intro.ts)
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        {/* blocking on purpose: it hides a dismissed intro band before the first paint, so nothing shifts */}
        <script dangerouslySetInnerHTML={{ __html: INTRO_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

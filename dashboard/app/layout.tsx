import type { Metadata, Viewport } from 'next';
import './globals.css';

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

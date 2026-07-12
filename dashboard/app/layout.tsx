import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QuantCore — Real-time Options Pricing Engine',
  description:
    'Interactive Black-Scholes / Monte Carlo options pricing with live Greeks, ' +
    'P&L surface, and scenario analysis. C++ core, Apple Metal GPU, sub-5ms WebSocket streaming.',
  authors: [{ name: 'Gaurang Khurana', url: 'https://gaurangkhurana.ca' }],
  openGraph: {
    title: 'QuantCore — Real-time Options Pricing Engine',
    description:
      'Interactive options pricing with live Greeks and a P&L surface. ' +
      'C++ core · Apple Metal GPU (up to 69× vs NumPy) · sub-5ms streaming.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#060606',
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

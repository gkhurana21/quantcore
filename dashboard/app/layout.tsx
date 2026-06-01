import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QuantCore Dashboard',
  description: 'Live options pricing, Greeks, and scenario analysis',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

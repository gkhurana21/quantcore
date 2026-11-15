/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  // The dev server's floating "N" badge sits over the first tab of the phone tab bar and swallows its clicks
  // (and the browser tests'). It does not exist in the exported site.
  devIndicators: false,
};
export default nextConfig;

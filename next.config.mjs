/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Type errors must fail the build, never silently ship. Do not relax this to
  // unblock local iteration. Linting is no longer part of `next build` as of
  // Next.js 16; it runs as its own CI step (`npm run lint`).
  typescript: { ignoreBuildErrors: false },
  experimental: {
    // Tree-shake large icon/graph barrels to keep the client canvas bundle lean.
    optimizePackageImports: ['lucide-react', '@xyflow/react'],
  },
};

export default nextConfig;

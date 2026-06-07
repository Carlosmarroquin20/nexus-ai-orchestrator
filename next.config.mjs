/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Build-time gates are intentionally strict: type and lint errors must fail CI,
  // never silently ship. Do not relax these to unblock local iteration.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
  experimental: {
    // Tree-shake large icon/graph barrels to keep the client canvas bundle lean.
    optimizePackageImports: ['lucide-react', '@xyflow/react'],
  },
};

export default nextConfig;

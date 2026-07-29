import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  typescript: { ignoreBuildErrors: false },
  // `ws` loads optional native addons (bufferutil / utf-8-validate) that break
  // when webpack bundles them — "bufferUtil.mask is not a function". The Gemini
  // Live socket in /api/tts needs it, so keep it out of the server bundle.
  serverExternalPackages: ['ws'],
};

export default nextConfig;

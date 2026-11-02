import { imageHosts } from './image-hosts.config.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  productionBrowserSourceMaps: true,
  distDir: process.env.DIST_DIR || '.next',

  typescript: {
    ignoreBuildErrors: true,
  },

  eslint: {
    ignoreDuringBuilds: true,
  },

  images: {
    remotePatterns: imageHosts,
    minimumCacheTTL: 60,
  },

  outputFileTracingIncludes: {
    '/api/admin/deals/**': [
      './templates/MOU.docx',
      './templates/Option-Agreement-EMD-Program.docx',
      './templates/EarnestBridge_Affidavit_Ownership_and_Authority.docx',
      './templates/Operating-Agreement-DRE.docx',
      './templates/Action-by-Written-Consent-of-Mgr-FORM-NO-SIG.docx',
    ],
  },

  async redirects() {
    return [
      {
        source: '/',
        destination: '/login',
        permanent: false,
      },
      {
        source: '/sign-up-login',
        destination: '/login',
        permanent: true,
      },
    ];
  },

  webpack(
    config,
    {
      dev: dev
    }
  ) {
    if (dev) {
      const ignoredPaths = (process.env.WATCH_IGNORED_PATHS || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      config.watchOptions = {
        ignored: ignoredPaths.length
          ? ignoredPaths.map((p) => `**/${p.replace(/^\/+|\/+$/g, '')}/**`)
          : undefined,
      };
    }

    if (dev) {
      config.module.rules.push({
        test: /\.(jsx|tsx)$/,
        exclude: [/node_modules/],
        use: [{
          loader: '@dhiwise/component-tagger/nextLoader',
        }],
      });
    }

    return config;
  }
};
export default nextConfig;
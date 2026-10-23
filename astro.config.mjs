import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import managedRedirects from './src/data/redirects.json' with { type: 'json' };

export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  vite: {
    oxc: false,
    resolve: {
      tsconfigPaths: false,
    },
    build: {
      rolldownOptions: {
        tsconfig: false,
      },
    },
    environments: {
      astro: {
        oxc: false,
        build: {
          rolldownOptions: {
            tsconfig: false,
          },
        },
        resolve: {
          tsconfigPaths: false,
        },
      },
      client: {
        oxc: false,
        build: {
          rolldownOptions: {
            tsconfig: false,
          },
        },
        resolve: {
          tsconfigPaths: false,
        },
      },
      prerender: {
        oxc: false,
        build: {
          rolldownOptions: {
            tsconfig: false,
          },
        },
        resolve: {
          tsconfigPaths: false,
        },
      },
      ssr: {
        oxc: false,
        build: {
          rolldownOptions: {
            tsconfig: false,
          },
        },
        resolve: {
          tsconfigPaths: false,
        },
      },
    },
  },
  redirects: managedRedirects,
});

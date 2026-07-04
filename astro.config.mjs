// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

import preact from '@astrojs/preact';

// https://astro.build/config
export default defineConfig({
  site: 'https://deep-dive.avetavos.com',
  base: '/kubernetes',
  output: 'static',
  integrations: [starlight({
      title: 'Kubernetes — From Zero to Hero',
      head: [
        { tag: 'script', attrs: { type: 'module', src: '/kubernetes/enhance.js' } },
        { tag: 'link', attrs: { rel: 'manifest', href: '/kubernetes/manifest.webmanifest' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/kubernetes/apple-touch-icon.png' } },
        { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/kubernetes/icon-192.png' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#326CE5' } },
        { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' } },
        { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
        { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' } },
        { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: "Kubernetes — From Zero to Hero" } },
        { tag: 'script', content: "if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/kubernetes/sw.js',{scope:'/kubernetes/'}).catch(function(){})})}" },
      ],
      defaultLocale: 'en',
      locales: {
        en: { label: 'English', lang: 'en' },
        th: { label: 'ไทย', lang: 'th' },
      },
      customCss: ['./src/styles/custom.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/avetavos/kubernetes-deep-dive' }],
      sidebar: [
        { label: 'Foundations & Architecture', items: [{ autogenerate: { directory: 'foundations' } }] },
        { label: 'Workloads', items: [{ autogenerate: { directory: 'workloads' } }] },
        { label: 'Networking', items: [{ autogenerate: { directory: 'networking' } }] },
        { label: 'Storage & Configuration', items: [{ autogenerate: { directory: 'storage-and-config' } }] },
        { label: 'Scheduling & Scaling', items: [{ autogenerate: { directory: 'scheduling-and-scaling' } }] },
        { label: 'Observability & Security', items: [{ autogenerate: { directory: 'observability-and-security' } }] },
        { label: 'Production & Ecosystem', items: [{ autogenerate: { directory: 'production-and-ecosystem' } }] },
      ],
      }), preact()],
});

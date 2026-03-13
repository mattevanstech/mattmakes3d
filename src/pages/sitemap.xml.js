import { getPrints } from '../lib/notion';

export async function GET() {
  const prints = await getPrints();
  const base = 'https://mattmakes3d.com';
  const today = new Date().toISOString().split('T')[0];

  // Static pages
  const staticPages = [
    { url: `${base}/`, priority: '1.0', changefreq: 'daily' },
    { url: `${base}/archive/`, priority: '0.8', changefreq: 'weekly' },
  ];

  const urls = [
    ...staticPages.map(p => `
  <url>
    <loc>${p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`),
  ].join('');

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(sitemap, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

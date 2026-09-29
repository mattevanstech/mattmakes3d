/**
 * Traffic, counted here and reported to the Matt Evans Tech dashboard.
 *
 * This site is its own Worker on its own domain, so it never passes through
 * that site's code. It does sit on the same Cloudflare account, though, so it
 * writes straight into the same table rather than beaconing from the browser:
 * server-side means ad blockers cannot hide anyone, and it sees what a script
 * never does — crawlers, link unfurlers, feeds, dead URLs.
 *
 * Every row is stamped `mattmakes3d.com`. The dashboard keeps each site on
 * its own tab; a busy day here must never read as a busy day there.
 *
 * Nothing identifying is stored. No address, no cookie: a "visitor" is a hash
 * of address, browser and date, which groups one day's visits and means
 * nothing the next morning.
 *
 * Source of truth for this logic is src/lib/analytics.ts in the
 * mattevanstech-emdash repo. This is a deliberately slimmed copy.
 */
import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';

const SITE = 'mattmakes3d.com';
const SITE_TZ = 'America/Los_Angeles';

/** Plumbing rather than readership: the CMS, its API, built assets. */
const IGNORED = [
  '/_emdash/', '/api/', '/_astro/', '/_image', '/fonts/',
  '/favicon', '/apple-touch-icon', '/robots.txt', '/.well-known/',
];

const BOTS: [RegExp, string][] = [
  [/googlebot/i, 'Googlebot'], [/bingbot/i, 'Bingbot'], [/duckduckbot/i, 'DuckDuckBot'],
  [/applebot/i, 'Applebot'], [/facebookexternalhit|facebookcatalog/i, 'Facebook'],
  [/twitterbot/i, 'Twitterbot'], [/slackbot|slack-imgproxy/i, 'Slack'],
  [/discordbot/i, 'Discord'], [/linkedinbot/i, 'LinkedIn'], [/telegrambot/i, 'Telegram'],
  [/whatsapp/i, 'WhatsApp'], [/mastodon|akkoma|pleroma|misskey/i, 'Fediverse'],
  [/pinterest/i, 'Pinterest'],
  [/feedly|inoreader|newsblur|netnewswire|reeder|rss|feedbin/i, 'Feed reader'],
  [/gptbot|oai-searchbot|chatgpt-user/i, 'OpenAI'], [/claudebot|anthropic/i, 'Anthropic'],
  [/perplexitybot/i, 'Perplexity'], [/ccbot/i, 'Common Crawl'],
  [/ahrefsbot|semrushbot|mj12bot|dotbot|petalbot|dataforseo/i, 'SEO crawler'],
  [/uptimerobot|pingdom|betteruptime|statuscake/i, 'Uptime monitor'],
  [/curl|wget|python-requests|node-fetch|go-http-client|axios|httpie/i, 'Script'],
  [/bot\b|crawler|spider|crawling/i, 'Other bot'],
];

const classifyBot = (ua: string) => {
  for (const [re, name] of BOTS) if (re.test(ua)) return name;
  return '';
};

const classifyDevice = (ua: string) => {
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return 'mobile';
  return 'desktop';
};

/** Matches the dashboard's day buckets, which are Pacific rather than UTC. */
const localDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: SITE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);

function referrerHost(ref: string | null): string {
  if (!ref) return '';
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '');
    return host === SITE ? '' : host.slice(0, 120);
  } catch {
    return '';
  }
}

async function visitorHash(ip: string, ua: string, day: string): Promise<string> {
  const salt = ((env as Record<string, unknown>).ANALYTICS_SALT as string | undefined) ?? 'mattevanstech';
  const data = new TextEncoder().encode(`${day}|${salt}|${ip}|${ua}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function record(request: Request, url: URL, res: Response): Promise<void> {
  const db = (env as Record<string, unknown>).ANALYTICS as D1Database | undefined;
  if (!db) return;                                  // binding absent, e.g. local dev

  const ua = request.headers.get('user-agent') ?? '';
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const local = localDay(now);
  const bot = classifyBot(ua);
  const type = res.headers.get('content-type') ?? '';
  const kind = /application\/(rss|atom|xml)|text\/xml/.test(type) ? 'feed' : 'page';

  await db.prepare(
    `INSERT INTO an_hits
       (ts, day, local_day, hour, path, status, kind, ref_host, country, device, bot, bot_name, visitor, site)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    Math.floor(now.getTime() / 1000), day, local, now.getUTCHours(),
    // One page, one path: /prints/x and /prints/x/ are the same thing and
    // both get linked, so without this a page arrives split in two.
    (url.pathname.replace(/\/+$/, '') || '/').slice(0, 300),
    res.status, kind,
    referrerHost(request.headers.get('referer')),
    (request as any).cf?.country ?? request.headers.get('cf-ipcountry') ?? '',
    classifyDevice(ua),
    bot ? 1 : 0, bot,
    bot ? '' : await visitorHash(ip, ua, local),
    SITE,
  ).run();
}

export const onRequest = defineMiddleware(async (context, next) => {
  const res = await next();

  try {
    const url = context.url;
    const type = res.headers.get('content-type') ?? '';
    const countable =
      context.request.method === 'GET' &&
      !IGNORED.some((p) => url.pathname.startsWith(p)) &&
      /text\/html|application\/(rss|atom|xml)|text\/xml/.test(type);

    if (countable) {
      // Off the response path: a reader should never wait on a count.
      const cfContext = (context.locals as any).cfContext;
      const write = record(context.request, url, res)
        .catch((e) => console.error('Analytics write failed', e));
      if (cfContext?.waitUntil) cfContext.waitUntil(write); else await write;
    }
  } catch (e) {
    // Nothing about measuring the site may break serving it.
    console.error('Analytics skipped', e);
  }

  return res;
});

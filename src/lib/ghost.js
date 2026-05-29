/**
 * Ghost Content API helper.
 *
 * Fetches published blog posts from the headless Ghost instance at
 * GHOST_API_URL (https://mattmakes3d.digitalpress.blog). Read-only.
 *
 * The Content API key is safe to expose at the edge (it's read-only and
 * scoped to published content), but we still treat it as an env var so we
 * don't commit it. Set GHOST_API_URL + GHOST_CONTENT_API_KEY in .env locally
 * and in Vercel project envs.
 */

const GHOST_API_URL = import.meta.env.GHOST_API_URL;
const GHOST_KEY     = import.meta.env.GHOST_CONTENT_API_KEY;
const GHOST_VERSION = "v5.0"; // Accept-Version header

const baseURL = GHOST_API_URL ? `${GHOST_API_URL.replace(/\/$/, '')}/ghost/api/content` : null;

const HEADERS = {
  'Accept-Version': GHOST_VERSION,
};

/**
 * Normalize a Ghost post object to a flat, predictable shape for our pages.
 */
function normalize(p) {
  return {
    id:           p.id,
    title:        p.title ?? '',
    slug:         p.slug ?? '',
    excerpt:      p.custom_excerpt || p.excerpt || '',
    html:         p.html ?? '',
    featureImage: p.feature_image ?? '',
    featureImageAlt:     p.feature_image_alt ?? '',
    featureImageCaption: p.feature_image_caption ?? '',
    publishedAt:  p.published_at ?? '',
    updatedAt:    p.updated_at ?? '',
    readingTime:  p.reading_time ?? 0,
    tags:         (p.tags ?? []).map(t => ({ id: t.id, name: t.name, slug: t.slug })),
    primaryTag:   p.primary_tag ? { id: p.primary_tag.id, name: p.primary_tag.name, slug: p.primary_tag.slug } : null,
    authors:      (p.authors ?? []).map(a => ({
      id: a.id, name: a.name, slug: a.slug, profileImage: a.profile_image ?? '',
    })),
    primaryAuthor: p.primary_author ? {
      id: p.primary_author.id,
      name: p.primary_author.name,
      slug: p.primary_author.slug,
      profileImage: p.primary_author.profile_image ?? '',
    } : null,
    url:          p.url ?? '',  // Ghost canonical URL
  };
}

/**
 * Fetch all published blog posts, newest first.
 * Returns [] if Ghost isn't configured or the request fails.
 */
export async function getPosts({ limit = 'all' } = {}) {
  if (!baseURL || !GHOST_KEY) return [];

  const params = new URLSearchParams({
    key: GHOST_KEY,
    limit: String(limit),
    include: 'tags,authors',
    fields: 'id,title,slug,excerpt,custom_excerpt,feature_image,feature_image_alt,feature_image_caption,published_at,updated_at,reading_time,url',
  });

  try {
    const res = await fetch(`${baseURL}/posts/?${params}`, { headers: HEADERS });
    if (!res.ok) {
      console.warn(`Ghost getPosts: ${res.status} ${res.statusText}`);
      return [];
    }
    const data = await res.json();
    return (data.posts ?? []).map(normalize);
  } catch (err) {
    console.warn(`Ghost getPosts threw: ${err.message}`);
    return [];
  }
}

/**
 * Fetch a single post by slug, with full HTML body.
 * Returns null if not found or Ghost isn't configured.
 */
export async function getPost(slug) {
  if (!baseURL || !GHOST_KEY || !slug) return null;

  const params = new URLSearchParams({
    key: GHOST_KEY,
    include: 'tags,authors',
  });

  try {
    const res = await fetch(`${baseURL}/posts/slug/${encodeURIComponent(slug)}/?${params}`, { headers: HEADERS });
    if (!res.ok) {
      if (res.status !== 404) console.warn(`Ghost getPost(${slug}): ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    const post = data.posts?.[0];
    return post ? normalize(post) : null;
  } catch (err) {
    console.warn(`Ghost getPost(${slug}) threw: ${err.message}`);
    return null;
  }
}

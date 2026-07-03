/**
 * Blog (Workshop Journal) data access.
 *
 * Formerly backed by the Ghost Content API; now backed by EmDash (Cloudflare D1).
 * Post bodies are Portable Text — the detail page renders them with EmDash's
 * <PortableText> component (see blog/[slug].astro), so `content` is passed
 * through instead of the old pre-rendered `html`.
 *
 * Export names + shapes are otherwise unchanged from the Ghost helper.
 */
import { getEmDashCollection, getEmDashEntry } from "emdash";
import { mediaUrl } from "./notion.js";

/** Rough reading time (~200 wpm) from Portable Text blocks. */
function readingTime(blocks) {
	if (!Array.isArray(blocks)) return 0;
	let words = 0;
	for (const b of blocks) {
		for (const c of b?.children ?? []) {
			if (typeof c?.text === "string") words += c.text.trim().split(/\s+/).filter(Boolean).length;
		}
	}
	return Math.max(1, Math.round(words / 200));
}

function primaryTagFrom(entry) {
	const tags = entry.data.terms?.tag ?? [];
	const t = tags[0];
	return t ? { name: t.label, slug: t.slug } : null;
}

function toPost(entry) {
	const tags = (entry.data.terms?.tag ?? []).map((t) => ({ name: t.label, slug: t.slug }));
	const byline = entry.data.byline ?? entry.data.bylines?.[0]?.byline ?? null;
	return {
		id: entry.data.id,
		title: entry.data.title ?? "",
		slug: entry.data.slug || entry.id,
		excerpt: entry.data.excerpt ?? "",
		content: entry.data.content ?? [],
		featureImage: mediaUrl(entry.data.featured_image),
		featureImageAlt: entry.data.featured_image?.alt ?? "",
		featureImageCaption: "",
		publishedAt: entry.data.publishedAt ? new Date(entry.data.publishedAt).toISOString() : "",
		readingTime: readingTime(entry.data.content),
		tags,
		primaryTag: primaryTagFrom(entry),
		primaryAuthor: byline
			? { name: byline.displayName ?? "", profileImage: "" }
			: null,
	};
}

/** All published posts, newest first. */
export async function getPosts() {
	const { entries } = await getEmDashCollection("posts", {
		status: "published",
		limit: 500,
		orderBy: { published_at: "desc" },
	});
	return entries
		.map(toPost)
		.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
}

/** A single post by slug, with full Portable Text body. Null if not found. */
export async function getPost(slug) {
	if (!slug) return null;
	const { entry } = await getEmDashEntry("posts", slug);
	return entry ? toPost(entry) : null;
}

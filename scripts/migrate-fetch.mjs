/**
 * Phase 3 — Migration step 1: FETCH + TRANSFORM
 *
 * Pulls the current content out of Notion (prints + deals) and Ghost (posts)
 * and writes a single intermediate JSON file that the loader step consumes.
 *
 * Read-only against Notion + Ghost. Writes nothing back to either source.
 *
 * Run: node --env-file=.env scripts/migrate-fetch.mjs
 * Out: scripts/migration-data.json
 */
import { writeFileSync } from "node:fs";
import TurndownService from "turndown";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PRINTS_DB = "31737eb9-8530-8036-b514-e688248e45fc";
const DEALS_DB = "632deb71-b945-4967-a8fe-93977d4b2e7d";
const NOTION_VERSION = "2022-06-28";

const GHOST_API_URL = process.env.GHOST_API_URL;
const GHOST_KEY = process.env.GHOST_CONTENT_API_KEY;

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function toSlug(title) {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function notionQuery(dbId, body) {
	const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${NOTION_TOKEN}`,
			"Content-Type": "application/json",
			"Notion-Version": NOTION_VERSION,
		},
		body: JSON.stringify(body ?? {}),
	});
	if (!res.ok) throw new Error(`Notion ${dbId}: ${res.status} ${res.statusText}`);
	return res.json();
}

function notionPhoto(props, slug, date) {
	// Match the live site's derived-URL convention, with a Notion-file fallback.
	if (slug && date) return `https://cdn.mattmakes3d.com/images/${slug}-${date}.jpg`;
	const files = props.Photo?.files ?? [];
	if (files.length) {
		const f = files[0];
		return f.type === "external" ? f.external.url : (f.file?.url ?? "");
	}
	return "";
}

async function getPrints() {
	const data = await notionQuery(PRINTS_DB, {});
	return data.results.map((page) => {
		const p = page.properties;
		const title = p["Model Name"]?.title?.[0]?.plain_text ?? "";
		const date = p["Print Date"]?.date?.start ?? "";
		const slug = toSlug(title);
		const statusName = p["Status"]?.status?.name ?? "";
		const print_status =
			statusName === "Done" ? "done" :
			statusName === "In Print Queue" ? "queued" : toSlug(statusName);
		return {
			notionId: page.id,
			title,
			slug,
			print_date: date || null,
			print_status,
			photo: notionPhoto(p, slug, date),
			model_url: p["Model Source URL"]?.url ?? "",
			source: p["Source"]?.rich_text?.[0]?.plain_text ?? "",
			featured: p["Featured"]?.checkbox ?? false,
		};
	});
}

async function getDeals() {
	const data = await notionQuery(DEALS_DB, {});
	return data.results.map((page) => {
		const p = page.properties;
		const title = p["Name"]?.title?.[0]?.plain_text ?? "";
		const files = p["Photo"]?.files ?? [];
		let photo = "";
		if (files.length) {
			const f = files[0];
			photo = f.type === "external" ? f.external.url : (f.file?.url ?? "");
		}
		return {
			notionId: page.id,
			title,
			slug: toSlug(title),
			photo,
			category: p["Category"]?.select?.name ?? "",
			price: p["Price"]?.number ?? null,
			original_price: p["Original Price"]?.number ?? null,
			url: p["URL"]?.url ?? "",
			source: p["Source"]?.select?.name ?? "",
			deal_status: (p["Status"]?.select?.name ?? "").toLowerCase(),
			my_take: p["My Take"]?.rich_text?.map((r) => r.plain_text).join("") ?? "",
			featured: p["Featured"]?.checkbox ?? false,
		};
	});
}

async function getGhostPosts() {
	if (!GHOST_API_URL || !GHOST_KEY) return [];
	const base = `${GHOST_API_URL.replace(/\/$/, "")}/ghost/api/content`;
	const params = new URLSearchParams({
		key: GHOST_KEY,
		limit: "all",
		include: "tags,authors",
	});
	const res = await fetch(`${base}/posts/?${params}`, { headers: { "Accept-Version": "v5.0" } });
	if (!res.ok) throw new Error(`Ghost: ${res.status} ${res.statusText}`);
	const data = await res.json();
	return (data.posts ?? []).map((p) => ({
		ghostId: p.id,
		title: p.title ?? "",
		slug: p.slug ?? "",
		excerpt: p.custom_excerpt || p.excerpt || "",
		markdown: p.html ? td.turndown(p.html) : "",
		featureImage: p.feature_image ?? "",
		featureImageAlt: p.feature_image_alt ?? "",
		published_at: p.published_at ?? null,
		tags: (p.tags ?? []).map((t) => ({ slug: t.slug, label: t.name })),
	}));
}

const [prints, deals, posts] = await Promise.all([getPrints(), getDeals(), getGhostPosts()]);

const out = { fetchedAt: new Date().toISOString(), prints, deals, posts };
writeFileSync(new URL("./migration-data.json", import.meta.url), JSON.stringify(out, null, 2));

console.log(`Prints: ${prints.length} (done: ${prints.filter((p) => p.print_status === "done").length}, queued: ${prints.filter((p) => p.print_status === "queued").length})`);
console.log(`Deals:  ${deals.length}`);
console.log(`Posts:  ${posts.length}`);
console.log("Wrote scripts/migration-data.json");

/**
 * Print-log data access.
 *
 * Formerly backed by the Notion API; now backed by EmDash (Cloudflare D1).
 * The exported function names + return shapes are unchanged so the pages and
 * components that consume them didn't need to change.
 */
import { getEmDashCollection, getEmDashEntry } from "emdash";

/** Convert a title to a URL-safe slug. Kept for components that still call it. */
export function toSlug(title) {
	return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Resolve an EmDash image field (object) to a URL string for <img src>. */
export function mediaUrl(img) {
	if (!img) return "";
	if (typeof img === "string") return img;
	if (img.src) return img.src;
	const key = img.meta?.storageKey ?? img.id;
	return key ? `/_emdash/api/media/file/${key}` : "";
}

/** ISO datetime → "YYYY-MM-DD". */
function toDate(v) {
	if (!v) return "";
	return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
}

function toPrint(e) {
	return {
		id: e.data.id,
		title: e.data.title ?? "",
		slug: e.data.slug || e.id,
		date: toDate(e.data.print_date),
		photo: mediaUrl(e.data.featured_image),
		model_url: e.data.model_url ?? "",
		model_source: e.data.source ?? "",
		featured: !!e.data.featured,
		notes: e.data.content ?? null,
	};
}

async function allPrints() {
	const { entries } = await getEmDashCollection("prints", {
		status: "published",
		limit: 500,
	});
	return entries;
}

/** Completed prints (Status = "Done"), newest first. */
export async function getPrints() {
	const entries = await allPrints();
	return entries
		.filter((e) => e.data.print_status === "done")
		.map(toPrint)
		.sort((a, b) => b.date.localeCompare(a.date));
}

/** A single completed print by slug, or null. */
export async function getPrint(slug) {
	if (!slug) return null;
	const { entry } = await getEmDashEntry("prints", slug);
	return entry ? toPrint(entry) : null;
}

/** Items currently queued to print (Status = "In Print Queue"). */
export async function getQueue() {
	const entries = await allPrints();
	return entries
		.filter((e) => e.data.print_status === "queued")
		.map((e) => ({
			id: e.data.id,
			title: e.data.title ?? "",
			url: e.data.model_url ?? "",
			source: e.data.source ?? "",
		}))
		.sort((a, b) => a.title.localeCompare(b.title));
}

/** Live workshop picks (deals). Featured first, then newest. */
export async function getDeals() {
	const { entries } = await getEmDashCollection("deals", {
		status: "published",
		limit: 500,
		orderBy: { created_at: "desc" },
	});
	return entries
		.filter((e) => (e.data.deal_status ?? "live") === "live")
		.map((e) => ({
			id: e.data.id,
			title: e.data.title ?? "",
			slug: e.data.slug || e.id,
			photo: mediaUrl(e.data.featured_image),
			category: e.data.category ?? "",
			price: e.data.price ?? null,
			originalPrice: e.data.original_price ?? null,
			url: e.data.url ?? "",
			source: e.data.source ?? "",
			myTake: e.data.my_take ?? "",
			featured: !!e.data.featured,
		}))
		.sort((a, b) => Number(b.featured) - Number(a.featured));
}

/**
 * Phase 3 — Migration step 2: LOAD into EmDash
 *
 * Reads scripts/migration-data.json and loads every record into the running
 * EmDash instance via the CLI:
 *   - downloads each image and `media upload`s it, capturing the media id
 *   - `content create`s the entry with that media id as featured_image
 *
 * Posts pass their body as markdown; EmDash converts it to Portable Text.
 * Content auto-publishes. Safe to point at localhost dev (dev-bypass auth).
 *
 * Run (dev server must be running):  node scripts/migrate-load.mjs
 * Target another instance:           EMDASH_URL=https://... node scripts/migrate-load.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const URL_ARG = process.env.EMDASH_URL ? ["--url", process.env.EMDASH_URL] : [];
const BIN = new URL("../node_modules/.bin/emdash", import.meta.url).pathname;
const data = JSON.parse(readFileSync(new URL("./migration-data.json", import.meta.url)));
const imgDir = mkdtempSync(join(tmpdir(), "mig-img-"));

function emdash(args) {
	const out = execFileSync(BIN, [...args, ...URL_ARG, "--json"], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return JSON.parse(out);
}

async function uploadImage(url, alt, i) {
	if (!url) return null;
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`  ! image ${res.status} ${url}`);
		return null;
	}
	const ext = (res.headers.get("content-type") || "").includes("png") ? "png" : "jpg";
	const file = join(imgDir, `img-${i}.${ext}`);
	writeFileSync(file, Buffer.from(await res.arrayBuffer()));
	const m = emdash(["media", "upload", file, "--alt", alt || ""]);
	return m.id ?? null;
}

function create(collection, slug, dataObj) {
	// Drop null/empty/undefined so we don't write blank columns.
	const clean = Object.fromEntries(
		Object.entries(dataObj).filter(([, v]) => v !== null && v !== undefined && v !== ""),
	);
	return emdash(["content", "create", collection, "--slug", slug, "--data", JSON.stringify(clean)]);
}

let n = 0;
const summary = { prints: 0, deals: 0, posts: 0, images: 0, failures: [] };

// ── Prints ────────────────────────────────────────────────────────────────
console.log(`\nPrints (${data.prints.length})…`);
for (const p of data.prints) {
	try {
		const mediaId = await uploadImage(p.photo, p.title, n++);
		if (mediaId) summary.images++;
		create("prints", p.slug, {
			title: p.title,
			featured_image: mediaId,
			print_date: p.print_date,
			print_status: p.print_status,
			model_url: p.model_url,
			source: p.source,
			featured: p.featured,
		});
		summary.prints++;
		process.stdout.write(".");
	} catch (e) {
		summary.failures.push([p.slug, String(e).split("\n")[0]]);
		process.stdout.write("x");
	}
}

// ── Deals ───────────────────────────────────────────────────────────────────
console.log(`\nDeals (${data.deals.length})…`);
for (const d of data.deals) {
	try {
		const mediaId = await uploadImage(d.photo, d.title, n++);
		if (mediaId) summary.images++;
		create("deals", d.slug, {
			title: d.title,
			featured_image: mediaId,
			category: d.category,
			price: d.price,
			original_price: d.original_price,
			url: d.url,
			source: d.source,
			deal_status: d.deal_status,
			my_take: d.my_take,
			featured: d.featured,
		});
		summary.deals++;
		process.stdout.write(".");
	} catch (e) {
		summary.failures.push([d.slug, String(e).split("\n")[0]]);
		process.stdout.write("x");
	}
}

// ── Posts ─────────────────────────────────────────────────────────────────
console.log(`\nPosts (${data.posts.length})…`);
for (const post of data.posts) {
	try {
		const mediaId = await uploadImage(post.featureImage, post.featureImageAlt || post.title, n++);
		if (mediaId) summary.images++;
		// Note: publishedAt is a system field set at publish time, not settable
		// on create. Original Ghost dates can be backfilled via `content schedule`
		// or the admin if exact ordering matters (only 1 post today).
		create("posts", post.slug, {
			title: post.title,
			featured_image: mediaId,
			excerpt: post.excerpt,
			content: post.markdown,
		});
		summary.posts++;
		process.stdout.write(".");
	} catch (e) {
		summary.failures.push([post.slug, String(e).split("\n")[0]]);
		process.stdout.write("x");
	}
}

console.log("\n\n── Summary ──");
console.log(`Prints:  ${summary.prints}/${data.prints.length}`);
console.log(`Deals:   ${summary.deals}/${data.deals.length}`);
console.log(`Posts:   ${summary.posts}/${data.posts.length}`);
console.log(`Images:  ${summary.images}`);
if (summary.failures.length) {
	console.log("Failures:");
	for (const [slug, err] of summary.failures) console.log(`  ${slug}: ${err}`);
} else {
	console.log("No failures.");
}

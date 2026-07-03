/**
 * Buffer Share — native EmDash plugin.
 *
 * Adds a "Share to Buffer" admin page: pick a published post, preview the
 * X/Threads text + image, and queue it to Buffer (which posts to your connected
 * X and Threads channels on your schedule).
 *
 * Uses Buffer's GraphQL API (https://api.buffer.com) with a personal API key
 * (org owner → Buffer Settings → Developers). The key is stored as a plugin
 * "secret" setting.
 *
 * NOTE: the exact Buffer GraphQL queries/mutations below are finalized against
 * the live schema via introspection (see scripts/buffer-introspect.mjs) because
 * Buffer's GraphQL API is beta and under-documented. Marked with BUFFER_TODO.
 */
import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";
import { z } from "astro/zod";

const BUFFER_GRAPHQL = "https://api.buffer.com";

// ─── Descriptor (imported in astro.config.mjs, runs at build time) ───────────
export function bufferSharePlugin(): PluginDescriptor {
	return {
		id: "buffer-share",
		version: "1.0.0",
		entrypoint: "@mattmakes3d/buffer-share",
		adminEntry: "@mattmakes3d/buffer-share/admin",
		capabilities: ["content:read", "media:read", "network:request"],
		allowedHosts: ["api.buffer.com"],
		adminPages: [{ path: "/", label: "Share to Buffer", icon: "share" }],
		fieldWidgets: [
			{ name: "share-button", label: "Share to Buffer", fieldTypes: ["json"] },
		],
		options: {},
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
type Ctx = any; // EmDash RouteContext (content, media, http, kv, log, input)

async function bufferGraphQL(ctx: Ctx, token: string, query: string, variables: Record<string, unknown> = {}) {
	const res = await ctx.http.fetch(BUFFER_GRAPHQL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ query, variables }),
	});
	const json: any = await res.json();
	if (json.errors?.length) {
		throw new Error(`Buffer API: ${json.errors.map((e: any) => e.message).join("; ")}`);
	}
	return json.data;
}

/** Resolve an EmDash image field to a public URL served by the Worker. */
function imageUrl(img: any): string {
	if (!img) return "";
	if (typeof img === "string") return img;
	if (img.src) return img.src;
	const key = img.meta?.storageKey ?? img.id;
	return key ? `/_emdash/api/media/file/${key}` : "";
}

async function getToken(ctx: Ctx): Promise<string> {
	const token = await ctx.kv.get<string>("settings:bufferToken");
	if (!token) throw new Error("Buffer API key not set. Add it in the plugin settings.");
	return token;
}

async function getSiteBaseUrl(ctx: Ctx): Promise<string> {
	return (await ctx.kv.get<string>("settings:siteBaseUrl")) || "https://mattmakes3d.com";
}

/** Buffer requires an organizationId for most queries. */
async function getOrgId(ctx: Ctx, token: string): Promise<string> {
	const data = await bufferGraphQL(ctx, token, `query { account { organizations { id } } }`);
	const id = data?.account?.organizations?.[0]?.id;
	if (!id) throw new Error("No Buffer organization found for this API key.");
	return id;
}

/** Connected X (twitter) + Threads channels, excluding disconnected ones. */
async function getChannels(ctx: Ctx, token: string) {
	const orgId = await getOrgId(ctx, token);
	const data = await bufferGraphQL(
		ctx,
		token,
		`query($o: OrganizationId!) {
			channels(input: { organizationId: $o }) { id name displayName service isDisconnected }
		}`,
		{ o: orgId },
	);
	return (data?.channels ?? [])
		.filter((c: any) => !c.isDisconnected && ["twitter", "threads"].includes(c.service))
		.map((c: any) => ({ id: c.id, service: c.service, name: c.name ?? c.displayName }));
}

/**
 * Read the account's Buffer posts and return a map of the /prints/<segment>
 * link found in each → earliest post timestamp. Used to retroactively mark
 * prints that were already shared (even outside this plugin). The <segment>
 * may be a slug or an internal id, so callers match on both.
 */
async function getBufferShares(ctx: Ctx, token: string): Promise<Record<string, string>> {
	const orgId = await getOrgId(ctx, token);
	const data = await bufferGraphQL(
		ctx,
		token,
		`query($o: OrganizationId!) {
			posts(input: { organizationId: $o }, first: 100) {
				edges { node { text sentAt createdAt } }
			}
		}`,
		{ o: orgId },
	);
	const out: Record<string, string> = {};
	for (const edge of data?.posts?.edges ?? []) {
		const node = edge.node;
		const matches = (node.text ?? "").match(/\/prints\/([A-Za-z0-9-]+)/g) ?? [];
		const ts = node.sentAt ?? node.createdAt ?? new Date().toISOString();
		for (const m of matches) {
			const seg = m.replace("/prints/", "");
			if (!out[seg] || ts < out[seg]) out[seg] = ts;
		}
	}
	return out;
}

const CREATE_POST = `
	mutation($input: CreatePostInput!) {
		createPost(input: $input) {
			__typename
			... on PostActionSuccess { post { id } }
			... on NotFoundError { message }
			... on UnauthorizedError { message }
			... on UnexpectedError { message }
			... on RestProxyError { message }
			... on LimitReachedError { message }
			... on InvalidInputError { message }
		}
	}`;

// ─── Implementation (default export, runs at request time) ───────────────────
export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: "buffer-share",
		version: "1.0.0",
		capabilities: ["content:read", "media:read", "network:request"],
		allowedHosts: ["api.buffer.com"],

		admin: {
			settingsSchema: {
				bufferToken: { type: "secret", label: "Buffer API Key" },
				siteBaseUrl: { type: "string", label: "Site URL (for post links)" },
			},
			pages: [{ path: "/", label: "Share to Buffer", icon: "share" }],
			fieldWidgets: [
				{ name: "share-button", label: "Share to Buffer", fieldTypes: ["json"] },
			],
		},

		routes: {
			// List finished prints (Done, with a photo) for the picker.
			posts: {
				handler: async (ctx: Ctx) => {
					const result = await ctx.content.list("prints", { status: "published", limit: 200 });
					const items = result.items ?? result.entries ?? result ?? [];
					const shared = (await ctx.kv.get<Record<string, string>>("sharedMap")) ?? {};

					// Retroactively detect shares that already exist in Buffer (by the
					// /prints/<segment> link), so prints shared before/outside this plugin
					// still get a ✓. Segment may be a slug or an internal id.
					let bufferShares: Record<string, string> = {};
					const token = await ctx.kv.get<string>("settings:bufferToken");
					if (token) {
						try {
							bufferShares = await getBufferShares(ctx, token);
						} catch (e) {
							ctx.log?.warn?.(`Buffer sync skipped: ${(e as Error).message}`);
						}
					}

					let dirty = false;
					const out = items
						.map((e: any) => {
							const d = e.data ?? e;
							const id = e.id ?? d.slug ?? d.id;
							const slug = e.slug ?? d.slug ?? id;
							const sharedAt =
								shared[id] ?? bufferShares[slug] ?? bufferShares[id] ?? null;
							// Persist a newly-detected Buffer share into our own map.
							if (sharedAt && !shared[id]) {
								shared[id] = sharedAt;
								dirty = true;
							}
							return {
								id,
								title: d.title ?? "",
								source: d.source ?? "",
								excerpt: d.source ? `Model from ${d.source}` : "",
								slug,
								status: d.print_status ?? "done",
								imageUrl: imageUrl(d.featured_image),
								sharedAt,
							};
						})
						// Only completed makes (queued prints have no photo).
						.filter((p: any) => p.status === "done");

					if (dirty) await ctx.kv.set("sharedMap", shared);
					return { items: out };
				},
			},

			// Does the plugin have what it needs? (drives the settings prompt in the UI)
			status: {
				handler: async (ctx: Ctx) => ({
					hasToken: !!(await ctx.kv.get<string>("settings:bufferToken")),
					siteBaseUrl: (await ctx.kv.get<string>("settings:siteBaseUrl")) || "",
				}),
			},

			// Shared state for a single print (used by the in-editor button).
			"print-status": {
				input: z.object({ postId: z.string() }),
				handler: async (ctx: Ctx) => {
					const { postId } = ctx.input as { postId: string };
					const token = await ctx.kv.get<string>("settings:bufferToken");
					const shared = (await ctx.kv.get<Record<string, string>>("sharedMap")) ?? {};
					let sharedAt = shared[postId] ?? null;
					if (token && !sharedAt) {
						try {
							const entry = await ctx.content.get("prints", postId);
							const slug = entry?.slug ?? entry?.data?.slug ?? postId;
							const bs = await getBufferShares(ctx, token);
							sharedAt = bs[slug] ?? bs[postId] ?? null;
							if (sharedAt) {
								shared[postId] = sharedAt;
								await ctx.kv.set("sharedMap", shared);
							}
						} catch (e) {
							ctx.log?.warn?.(`print-status buffer check skipped: ${(e as Error).message}`);
						}
					}
					return { hasToken: !!token, sharedAt };
				},
			},

			// Save the Buffer API key (secret) + optional site URL.
			"settings/save": {
				input: z.object({
					bufferToken: z.string().optional(),
					siteBaseUrl: z.string().optional(),
				}),
				handler: async (ctx: Ctx) => {
					const { bufferToken, siteBaseUrl } = ctx.input as { bufferToken?: string; siteBaseUrl?: string };
					if (bufferToken) await ctx.kv.set("settings:bufferToken", bufferToken);
					if (siteBaseUrl !== undefined) await ctx.kv.set("settings:siteBaseUrl", siteBaseUrl);
					return { saved: true };
				},
			},

			// List connected Buffer channels (X + Threads).
			channels: {
				handler: async (ctx: Ctx) => {
					const token = await getToken(ctx);
					return { channels: await getChannels(ctx, token) };
				},
			},

			// Build the post text + image and queue it to Buffer on X + Threads.
			share: {
				input: z.object({
					postId: z.string(),
					channelIds: z.array(z.string()).optional(),
				}),
				handler: async (ctx: Ctx) => {
					const token = await getToken(ctx);
					const { postId, channelIds } = ctx.input as { postId: string; channelIds?: string[] };

					const entry = await ctx.content.get("prints", postId);
					if (!entry) throw new Error(`Print not found: ${postId}`);
					const d = entry.data ?? entry;

					const base = await getSiteBaseUrl(ctx);
					const slug = entry.slug ?? d.slug ?? entry.id;
					const link = `${base}/prints/${slug}`;
					const intro = d.source
						? `Check out this ${d.title} that I printed, model from ${d.source}.`
						: `Check out this ${d.title} that I printed.`;
					const text = `${intro}\n\n${link}`;
					const image = imageUrl(d.featured_image);
					const imageAbsolute = image.startsWith("http") ? image : `${base}${image}`;

					// Resolve targets: provided channel ids, else all connected X + Threads.
					let targets = channelIds;
					if (!targets?.length) {
						targets = (await getChannels(ctx, token)).map((c) => c.id);
					}
					if (!targets?.length) throw new Error("No X/Threads channels connected in Buffer.");

					// One createPost per channel — queue it (addToQueue) with an image asset.
					const assets = imageAbsolute ? [{ image: { url: imageAbsolute } }] : [];
					const results = [];
					for (const channelId of targets) {
						const data = await bufferGraphQL(ctx, token, CREATE_POST, {
							// mode:addToQueue + schedulingType:automatic → Buffer queues it and
							// auto-publishes to the channel on your posting schedule.
							input: { channelId, text, assets, mode: "addToQueue", schedulingType: "automatic" },
						});
						const payload = data?.createPost;
						if (payload?.__typename !== "PostActionSuccess") {
							throw new Error(`Buffer rejected the post: ${payload?.message ?? payload?.__typename ?? "unknown error"}`);
						}
						results.push({ channelId, id: payload?.post?.id });
					}
					// Record that this print has been shared (drives the ✓ in the list).
					const sharedAt = new Date().toISOString();
					const shared = (await ctx.kv.get<Record<string, string>>("sharedMap")) ?? {};
					shared[postId] = sharedAt;
					await ctx.kv.set("sharedMap", shared);

					ctx.log.info(`Shared print ${postId} to ${results.length} Buffer channel(s)`);
					return { shared: results.length, results, sharedAt };
				},
			},
		},
	});
}

export default createPlugin;

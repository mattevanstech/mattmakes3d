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
		},

		routes: {
			// List published posts for the picker.
			posts: {
				handler: async (ctx: Ctx) => {
					const result = await ctx.content.list("posts", { status: "published", limit: 100 });
					const items = result.items ?? result.entries ?? result ?? [];
					return {
						items: items.map((e: any) => {
							const d = e.data ?? e;
							return {
								id: e.id ?? d.slug ?? d.id,
								title: d.title ?? "",
								excerpt: d.excerpt ?? "",
								slug: d.slug ?? e.id,
								imageUrl: imageUrl(d.featured_image),
							};
						}),
					};
				},
			},

			// Does the plugin have what it needs? (drives the settings prompt in the UI)
			status: {
				handler: async (ctx: Ctx) => ({
					hasToken: !!(await ctx.kv.get<string>("settings:bufferToken")),
					siteBaseUrl: (await ctx.kv.get<string>("settings:siteBaseUrl")) || "",
				}),
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

					const entry = await ctx.content.get("posts", postId);
					if (!entry) throw new Error(`Post not found: ${postId}`);
					const d = entry.data ?? entry;

					const base = await getSiteBaseUrl(ctx);
					const link = `${base}/blog/${d.slug ?? entry.id}`;
					const text = [d.title, d.excerpt, link].filter(Boolean).join("\n\n");
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
					ctx.log.info(`Shared post ${postId} to ${results.length} Buffer channel(s)`);
					return { shared: results.length, results };
				},
			},
		},
	});
}

export default createPlugin;

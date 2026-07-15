/**
 * Buffer Share — admin UI.
 *
 * A "Share to Buffer" page: pick a published post, preview the X/Threads text +
 * image, and queue it to Buffer. Talks to the plugin's own API routes.
 */
import type { PluginAdminExports } from "emdash";
import { apiFetch as baseFetch, getErrorMessage, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API = "/_emdash/api/plugins/buffer-share";

function apiFetch(route: string, body?: unknown): Promise<Response> {
	return baseFetch(`${API}/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}

interface Post {
	id: string;
	title: string;
	source: string;
	excerpt: string;
	slug: string;
	imageUrl: string;
	sharedAt?: string | null;
}

function SharePage() {
	const [posts, setPosts] = React.useState<Post[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [hasToken, setHasToken] = React.useState(true);
	const [selected, setSelected] = React.useState<Post | null>(null);
	const [sharing, setSharing] = React.useState(false);
	const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
	const [tokenInput, setTokenInput] = React.useState("");
	const [savingToken, setSavingToken] = React.useState(false);

	async function saveToken() {
		setSavingToken(true);
		setMessage(null);
		try {
			await parseApiResponse(await apiFetch("settings/save", { bufferToken: tokenInput }));
			setHasToken(true);
			setTokenInput("");
			setMessage({ ok: true, text: "Buffer key saved." });
		} catch (e) {
			setMessage({ ok: false, text: getErrorMessage(e) });
		} finally {
			setSavingToken(false);
		}
	}

	React.useEffect(() => {
		(async () => {
			try {
				const status = parseApiResponse<{ hasToken: boolean }>(await apiFetch("status"));
				const st = await status;
				setHasToken(st.hasToken);
				const data = parseApiResponse<{ items: Post[] }>(await apiFetch("posts"));
				setPosts((await data).items ?? []);
			} catch (e) {
				setMessage({ ok: false, text: getErrorMessage(e) });
			} finally {
				setLoading(false);
			}
		})();
	}, []);

	async function share() {
		if (!selected) return;
		setSharing(true);
		setMessage(null);
		try {
			const res = parseApiResponse<{ shared: number; sharedAt: string }>(await apiFetch("share", { postId: selected.id }));
			const r = await res;
			// Mark it shared immediately (drives the ✓ without a reload).
			setPosts((prev) => prev.map((p) => (p.id === selected.id ? { ...p, sharedAt: r.sharedAt } : p)));
			setSelected((s) => (s ? { ...s, sharedAt: r.sharedAt } : s));
			setMessage({ ok: true, text: `Queued to Buffer on ${r.shared} channel(s) — it'll post to X + Threads on your schedule.` });
		} catch (e) {
			setMessage({ ok: false, text: getErrorMessage(e) });
		} finally {
			setSharing(false);
		}
	}

	const base = "https://mattmakes3d.com";
	const previewText = selected
		? `${
				selected.source
					? `Check out this ${selected.title} that I printed, model from ${selected.source}.`
					: `Check out this ${selected.title} that I printed.`
			}\n\n${base}/prints/${selected.slug}`
		: "";

	if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

	return (
		<div style={{ padding: 24, maxWidth: 900 }}>
			<h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Share to Buffer</h1>
			<p style={{ color: "#666", marginBottom: 20 }}>
				Pick a print and queue it to Buffer — it posts to your connected X and Threads channels.
			</p>

			{!hasToken && (
				<div style={{ padding: 14, borderRadius: 8, background: "#fff7ed", color: "#9a3412", marginBottom: 16 }}>
					<div style={{ marginBottom: 8 }}>
						<strong>Connect Buffer.</strong> Generate a personal API key in Buffer (Settings → Developers),
						then paste it here.
					</div>
					<div style={{ display: "flex", gap: 8 }}>
						<input
							type="password"
							value={tokenInput}
							onChange={(e) => setTokenInput(e.target.value)}
							placeholder="Buffer API key"
							style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: "1px solid #e5e7eb" }}
						/>
						<button
							onClick={saveToken}
							disabled={!tokenInput || savingToken}
							style={{ padding: "8px 14px", borderRadius: 6, border: "none", background: "#2563eb", color: "#fff", fontWeight: 600, cursor: "pointer" }}
						>
							{savingToken ? "Saving…" : "Save key"}
						</button>
					</div>
				</div>
			)}

			{message && (
				<div
					style={{
						padding: 12, borderRadius: 8, marginBottom: 16,
						background: message.ok ? "#ecfdf5" : "#fef2f2",
						color: message.ok ? "#065f46" : "#991b1b",
					}}
				>
					{message.text}
				</div>
			)}

			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
				<div>
					<h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".08em", color: "#888", marginBottom: 8 }}>
						Prints
					</h2>
					<div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 480, overflowY: "auto" }}>
						{posts.map((p) => (
							<button
								key={p.id}
								onClick={() => { setSelected(p); setMessage(null); }}
								style={{
									textAlign: "left", padding: "10px 12px", borderRadius: 8, cursor: "pointer",
									border: selected?.id === p.id ? "2px solid #2563eb" : "1px solid #e5e7eb",
									background: selected?.id === p.id ? "#eff6ff" : "#fff",
								}}
							>
								<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
									{p.sharedAt && (
										<span
											title={`Shared to Buffer ${new Date(p.sharedAt).toLocaleString()}`}
											style={{ color: "#16a34a", fontWeight: 700, flexShrink: 0 }}
										>
											✓
										</span>
									)}
									<span style={{ fontWeight: 600 }}>{p.title}</span>
								</div>
								{p.excerpt && <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{p.excerpt.slice(0, 80)}…</div>}
							</button>
						))}
						{posts.length === 0 && <div style={{ color: "#888" }}>No prints yet.</div>}
					</div>
				</div>

				<div>
					<h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".08em", color: "#888", marginBottom: 8 }}>
						Preview
					</h2>
					{selected ? (
						<div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
							{selected.imageUrl && (
								<img src={selected.imageUrl} alt="" style={{ width: "100%", display: "block", aspectRatio: "16/9", objectFit: "cover" }} />
							)}
							<div style={{ padding: 14 }}>
								<pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 14, margin: 0 }}>{previewText}</pre>
								<div style={{ marginTop: 8, fontSize: 12, color: "#888" }}>
									X also gets <span style={{ color: "#2563eb" }}>#3dprinting #makers</span> (Threads stays clean)
								</div>
								{selected.sharedAt && (
									<div style={{ marginTop: 10, fontSize: 12, color: "#16a34a" }}>
										✓ Already shared {new Date(selected.sharedAt).toLocaleDateString()}
									</div>
								)}
								<button
									onClick={share}
									disabled={sharing || !hasToken}
									style={{
										marginTop: 14, width: "100%", padding: "10px 16px", borderRadius: 8, border: "none",
										background: sharing || !hasToken ? "#93c5fd" : "#2563eb", color: "#fff", fontWeight: 600,
										cursor: sharing || !hasToken ? "default" : "pointer",
									}}
								>
									{sharing ? "Queueing…" : selected.sharedAt ? "Share again (X + Threads)" : "Share to Buffer (X + Threads)"}
								</button>
							</div>
						</div>
					) : (
						<div style={{ color: "#888" }}>Select a print to preview.</div>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * In-editor "Share to Buffer" button (a field widget on the prints editor).
 * Gets the print id from the editor URL (/_emdash/admin/content/prints/<id>).
 */
function ShareButtonWidget(props: { value?: unknown; onChange?: (v: unknown) => void }) {
	const [postId, setPostId] = React.useState<string | null>(null);
	const [hasToken, setHasToken] = React.useState(true);
	const [sharedAt, setSharedAt] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

	// This is a display-only widget (a button), but EmDash treats field widgets
	// as controlled inputs — so ensure the field always has a valid value,
	// otherwise the editor can't serialize it and Save silently does nothing.
	React.useEffect(() => {
		if (props?.onChange && (props.value === undefined || props.value === null)) {
			props.onChange({});
		}
	}, []);

	React.useEffect(() => {
		const id = window.location.pathname.match(/\/content\/prints\/([^/?#]+)/)?.[1] ?? null;
		setPostId(id);
		if (!id || id === "new") return;
		(async () => {
			try {
				const st = await parseApiResponse<{ hasToken: boolean; sharedAt: string | null }>(
					await apiFetch("print-status", { postId: id }),
				);
				setHasToken(st.hasToken);
				setSharedAt(st.sharedAt);
			} catch {
				/* ignore — button still usable */
			}
		})();
	}, []);

	async function doShare() {
		if (!postId) return;
		setBusy(true);
		setMsg(null);
		try {
			const r = await parseApiResponse<{ shared: number; sharedAt: string }>(
				await apiFetch("share", { postId }),
			);
			setSharedAt(r.sharedAt);
			setMsg({ ok: true, text: `Queued to Buffer on ${r.shared} channel(s).` });
		} catch (e) {
			setMsg({ ok: false, text: getErrorMessage(e) });
		} finally {
			setBusy(false);
		}
	}

	if (!postId || postId === "new") {
		return <div style={{ fontSize: 13, color: "#888" }}>Save the print first, then share it to Buffer.</div>;
	}

	return (
		<div>
			<button
				onClick={doShare}
				disabled={busy || !hasToken}
				style={{
					padding: "8px 16px", borderRadius: 8, border: "none", fontWeight: 600,
					background: busy || !hasToken ? "#93c5fd" : "#2563eb", color: "#fff",
					cursor: busy || !hasToken ? "default" : "pointer",
				}}
			>
				{busy ? "Queueing…" : sharedAt ? "Share again to Buffer (X + Threads)" : "Share to Buffer (X + Threads)"}
			</button>
			{sharedAt && (
				<span style={{ marginLeft: 10, fontSize: 12, color: "#16a34a" }}>
					✓ Shared {new Date(sharedAt).toLocaleDateString()}
				</span>
			)}
			{!hasToken && (
				<div style={{ marginTop: 6, fontSize: 12, color: "#9a3412" }}>
					Add your Buffer API key on the “Share to Buffer” page first.
				</div>
			)}
			{msg && (
				<div style={{ marginTop: 6, fontSize: 12, color: msg.ok ? "#16a34a" : "#991b1b" }}>{msg.text}</div>
			)}
		</div>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/": SharePage,
};

export const fields: PluginAdminExports["fields"] = {
	"share-button": ShareButtonWidget,
};

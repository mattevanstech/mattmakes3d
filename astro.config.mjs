import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { github } from "emdash/auth/providers/github";
import { bufferSharePlugin } from "@mattmakes3d/buffer-share";

export default defineConfig({
	site: "https://mattmakes3d.com",
	output: "server",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			authProviders: [github()],
			plugins: [bufferSharePlugin()],
		}),
	],
	devToolbar: { enabled: false },
});

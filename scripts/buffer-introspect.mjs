/**
 * Introspect Buffer's GraphQL schema to finalize the plugin's queries/mutations.
 *
 * Buffer's GraphQL API is beta and under-documented, so we read the real schema
 * to get exact names/args for: listing channels, and creating an image post.
 *
 * Run:  BUFFER_TOKEN=your_key node scripts/buffer-introspect.mjs
 */
const TOKEN = process.env.BUFFER_TOKEN;
if (!TOKEN) {
	console.error("Set BUFFER_TOKEN=<your Buffer personal API key>");
	process.exit(1);
}

async function gql(query, variables = {}) {
	const res = await fetch("https://api.buffer.com", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ query, variables }),
	});
	const json = await res.json();
	if (json.errors) console.error("errors:", JSON.stringify(json.errors, null, 2));
	return json.data;
}

const INTROSPECT = `
query {
  __schema {
    queryType { name fields { name args { name type { name kind ofType { name kind } } } } }
    mutationType { name fields { name args { name type { name kind ofType { name kind } } } } }
  }
}`;

const data = await gql(INTROSPECT);
const q = data?.__schema?.queryType?.fields ?? [];
const m = data?.__schema?.mutationType?.fields ?? [];

const argStr = (f) =>
	f.args.map((a) => `${a.name}: ${a.type.name || a.type.ofType?.name || a.type.kind}`).join(", ");

console.log("\n=== QUERIES (channel/account/post related) ===");
q.filter((f) => /channel|account|organization|post|idea/i.test(f.name)).forEach((f) =>
	console.log(`  ${f.name}(${argStr(f)})`),
);

console.log("\n=== MUTATIONS (post/idea/draft/image related) ===");
m.filter((f) => /post|idea|draft|image|update|create/i.test(f.name)).forEach((f) =>
	console.log(`  ${f.name}(${argStr(f)})`),
);

console.log("\n=== ALL mutation names ===");
console.log("  " + m.map((f) => f.name).join(", "));

// Also try to fetch the real connected channels so we can see X/Threads ids + fields.
console.log("\n=== channels probe (adjust query if it errors) ===");
const ch = await gql(`query { account { channels { id name service serviceType } } }`).catch(() => null);
console.log(JSON.stringify(ch, null, 2));

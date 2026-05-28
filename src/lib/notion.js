/**
 * Notion API utility for fetching print log data.
 * Uses the Notion REST API directly (no SDK required).
 */

/**
 * Convert a print title to a URL-safe slug.
 * Used consistently across all pages and components.
 */
export function toSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const NOTION_TOKEN = import.meta.env.NOTION_TOKEN;
const DATABASE_ID = "31737eb9-8530-8036-b514-e688248e45fc";
const NOTION_VERSION = "2022-06-28";

/**
 * Shared helper to query the database with given filter + sort options.
 */
async function queryDatabase(body) {
  const url = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Notion API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Query the Notion database and return formatted print entries.
 * Only returns entries with Status = "Done", sorted by Print Date descending.
 */
export async function getPrints() {
  const url = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;

  const body = {
    filter: {
      property: "Status",
      status: {
        equals: "Done",
      },
    },
    sorts: [
      {
        property: "Print Date",
        direction: "descending",
      },
    ],
  };

  const data = await queryDatabase(body);

  return data.results.map((page) => {
    const props = page.properties;

    const title = props["Model Name"]?.title?.[0]?.plain_text ?? "";
    const date = props["Print Date"]?.date?.start ?? "";
    const slug = toSlug(title);

    // Derive the canonical CDN photo URL from slug + date.
    // All new uploads via the CDN upload tool follow this convention:
    //   https://cdn.mattmakes3d.com/images/{slug}-{YYYY-MM-DD}.jpg
    // Fall back to the Notion Photo field for any entries not yet migrated
    // to the CDN (e.g. photos still hosted on the old makes.mattevanstech.com host).
    let photo = "";
    if (slug && date) {
      photo = `https://cdn.mattmakes3d.com/images/${slug}-${date}.jpg`;
    } else {
      // Fallback: read directly from the Notion Photo field
      const photoFiles = props.Photo?.files ?? [];
      if (photoFiles.length > 0) {
        const file = photoFiles[0];
        photo = file.type === "external" ? file.external.url : (file.file?.url ?? "");
      }
    }

    return {
      id: page.id,
      title,
      slug,
      date,
      photo,
      model_url: props["Model Source URL"]?.url ?? "",
      model_source: props["Source"]?.rich_text?.[0]?.plain_text ?? "",
      featured: props["Featured"]?.checkbox ?? false,
    };
  });
}

// ── DEALS DATABASE ──────────────────────────────────────────────────────────
// The deals page (/deals) pulls from a separate Notion database from prints.
// Created on 2026-05-27 via the Notion MCP. Schema:
//   Name (Title), Photo (Files), Category (Select), Price (Number $),
//   Original Price (Number $), URL (URL), Source (Select), Status (Select),
//   My Take (Rich text), Featured (Checkbox)
const DEALS_DATABASE_ID = "632deb71-b945-4967-a8fe-93977d4b2e7d";

/**
 * Query the deals database. Returns deals with Status = "Live", featured first,
 * then newest first. Returns [] if the DB ID hasn't been configured or the API
 * call fails (e.g., the integration hasn't been invited to the database yet).
 */
export async function getDeals() {
  if (!DEALS_DATABASE_ID) return [];

  const url = `https://api.notion.com/v1/databases/${DEALS_DATABASE_ID}/query`;
  const body = {
    filter: {
      property: "Status",
      select: { equals: "Live" },
    },
    sorts: [
      { property: "Featured",      direction: "descending" },
      { timestamp: "created_time", direction: "descending" },
    ],
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.warn(`getDeals: Notion API ${response.status} ${response.statusText}`);
    return [];
  }
  const data = await response.json();

  return data.results.map((page) => {
    const props = page.properties;

    const title = props["Name"]?.title?.[0]?.plain_text ?? "";

    let photo = "";
    const photoFiles = props["Photo"]?.files ?? [];
    if (photoFiles.length > 0) {
      const file = photoFiles[0];
      photo = file.type === "external" ? file.external.url : (file.file?.url ?? "");
    }

    return {
      id: page.id,
      title,
      slug: toSlug(title),
      photo,
      category: props["Category"]?.select?.name ?? "",
      price: props["Price"]?.number ?? null,
      originalPrice: props["Original Price"]?.number ?? null,
      url: props["URL"]?.url ?? "",
      source: props["Source"]?.select?.name ?? "",
      myTake: props["My Take"]?.rich_text?.map(r => r.plain_text).join("") ?? "",
      featured: props["Featured"]?.checkbox ?? false,
    };
  });
}

/**
 * Fetch items currently in the print queue (Status = "In Print Queue").
 */
export async function getQueue() {
  const data = await queryDatabase({
    filter: {
      property: "Status",
      status: {
        equals: "In Print Queue",
      },
    },
    sorts: [
      {
        property: "Model Name",
        direction: "ascending",
      },
    ],
  });

  return data.results.map((page) => {
    const props = page.properties;
    return {
      id: page.id,
      title: props["Model Name"]?.title?.[0]?.plain_text ?? "",
      url: props["Model Source URL"]?.url ?? "",
      source: props["Source"]?.rich_text?.[0]?.plain_text ?? "",
    };
  });
}

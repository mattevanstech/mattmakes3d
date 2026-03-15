/**
 * Notion API utility for fetching print log data.
 * Uses the Notion REST API directly (no SDK required).
 */

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

    // Extract photo URL — supports external links (GitHub CDN, etc.) and legacy relative paths
    // If the URL is from the old makes.mattevanstech.com host, convert to a relative path.
    // All other URLs (GitHub CDN, etc.) are kept as full absolute URLs.
    let photo = "";
    const photoFiles = props.Photo?.files ?? [];
    if (photoFiles.length > 0) {
      const file = photoFiles[0];
      const rawUrl = file.type === "external" ? file.external.url : (file.file?.url ?? "");
      if (rawUrl.startsWith("https://makes.mattevanstech.com/")) {
        photo = rawUrl.replace("https://makes.mattevanstech.com/", "/");
      } else {
        photo = rawUrl; // full external URL (GitHub CDN, etc.)
      }
    }

    return {
      id: page.id,
      title: props["Model Name"]?.title?.[0]?.plain_text ?? "",
      date: props["Print Date"]?.date?.start ?? "",
      photo,
      model_url: props["Model Source URL"]?.url ?? "",
      model_source: props["Source"]?.rich_text?.[0]?.plain_text ?? "",
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

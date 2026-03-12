// ── Types shared across the site ──────────────────────────────────────────────

export interface Print {
  title: string;
  date: string;           // "YYYY-MM-DD"
  photo: string;          // relative path, e.g. "makes/03_01_2026_r2d2.jpg"
  model_url: string;
  model_source: string;   // "MakerWorld" | "Printables" | etc.
  featured: boolean;
}

export interface QueueItem {
  title: string;
  url: string;
  source: string;
}

// ── Future: swap these imports for Notion API calls ───────────────────────────
//
// import { Client } from "@notionhq/client";
// const notion = new Client({ auth: import.meta.env.NOTION_TOKEN });
//
// export async function getPrints(): Promise<Print[]> {
//   const response = await notion.databases.query({
//     database_id: import.meta.env.NOTION_DB_ID,
//     filter: { property: "Status", status: { equals: "Done" } },
//     sorts: [{ property: "Print Date", direction: "descending" }],
//   });
//   return response.results.map(notionPageToPrint);
// }
//
// export async function getQueue(): Promise<QueueItem[]> {
//   const response = await notion.databases.query({
//     database_id: import.meta.env.NOTION_DB_ID,
//     filter: { property: "Status", status: { equals: "In Print Queue" } },
//   });
//   return response.results.map(notionPageToQueueItem);
// }

// ── Types shared across the site ──────────────────────────────────────────────
// (Relocated from src/content/types.ts during the EmDash migration.)

export interface Print {
  title: string;
  slug: string;
  date: string;           // "YYYY-MM-DD"
  photo: string;          // absolute CDN/R2 URL
  model_url: string;
  model_source: string;   // "MakerWorld" | "Printables" | etc.
  featured: boolean;
}

export interface QueueItem {
  title: string;
  url: string;
  source: string;
}

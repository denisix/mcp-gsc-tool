import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFilterGroups, getDateRange, queryPages, type DimensionFilter, type SearchType } from "../analytics.js";

const csvCell = (v: string | number) => {
  const s = String(v);
  // Quote when needed; prefix formula starters so spreadsheets don't execute query text (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Writes a full Search Analytics export to a new CSV file, so large datasets never pass through the chat. */
export async function exportCsv(opts: {
  dimensions: string[];
  days?: number;
  filters?: DimensionFilter[];
  searchType?: SearchType;
  maxRows?: number;
  outputPath?: string;
}) {
  const { dimensions, days = 28, filters = [], searchType, maxRows = 1_000_000 } = opts;
  const outputPath = path.resolve(opts.outputPath ?? path.join(os.tmpdir(), `gsc-export-${Date.now()}.csv`));
  if (!outputPath.toLowerCase().endsWith(".csv")) throw new Error("output_path must end in .csv");

  const { startDate, endDate } = getDateRange(days);
  const columns = [...dimensions, "clicks", "impressions", "ctr", "position"];
  // "wx": never overwrite an existing file. Pages are written as they arrive, so 1M rows never sit in memory.
  const fd = fs.openSync(outputPath, "wx", 0o600);
  let rows = 0;
  const preview: (string | number)[][] = [];
  try {
    fs.writeSync(fd, `${columns.join(",")}\n`);
    const params = { startDate, endDate, dimensions, dimensionFilterGroups: buildFilterGroups(filters), type: searchType, maxRows };
    for await (const page of queryPages(params)) {
      for (const r of page) if (preview.length < 5) preview.push([...r.keys, r.clicks, r.impressions]);
      fs.writeSync(fd, page.map((r) => `${[...r.keys, r.clicks, r.impressions, r.ctr, r.position].map(csvCell).join(",")}\n`).join(""));
      rows += page.length;
    }
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(outputPath, { force: true }); // no half-written export left behind
    throw err;
  }
  fs.closeSync(fd);
  return { path: outputPath, rows, truncated: rows >= maxRows, period: { startDate, endDate }, columns, preview };
}

import { COMPARE_LAG_DAYS, fetchAllRows, getDateRange } from "../analytics.js";

interface DecayingPage {
  page: string;
  period1Clicks: number;
  period2Clicks: number;
  period3Clicks: number;
  totalClickLoss: number;
  period1Position: number;
  period2Position: number;
  period3Position: number;
  positionTrend: string;
}

export async function contentDecay(): Promise<DecayingPage[]> {
  // Three consecutive 30-day windows, newest first, ending before the partial recent days.
  const now = new Date();
  const [w1, w2, w3] = [0, 30, 60].map((back) => getDateRange(30, now, COMPARE_LAG_DAYS + back));

  const [rows1, rows2, rows3] = await Promise.all([
    fetchAllRows({ startDate: w1.startDate, endDate: w1.endDate, dimensions: ["page"] }),
    fetchAllRows({ startDate: w2.startDate, endDate: w2.endDate, dimensions: ["page"] }),
    fetchAllRows({ startDate: w3.startDate, endDate: w3.endDate, dimensions: ["page"] }),
  ]);

  const toMap = (rows: typeof rows1) => {
    const map = new Map<string, { clicks: number; position: number }>();
    for (const r of rows) {
      map.set(r.keys[0], { clicks: r.clicks, position: r.position });
    }
    return map;
  };

  const map1 = toMap(rows1);
  const map2 = toMap(rows2);
  const map3 = toMap(rows3);

  const decaying: DecayingPage[] = [];

  // Check all pages that exist in the oldest period
  for (const [page, p3] of map3) {
    const p2 = map2.get(page);
    const p1 = map1.get(page);

    if (!p2 || !p1) continue;

    // Consistent downward trend: p3 > p2 > p1 in clicks
    if (p3.clicks <= p2.clicks || p2.clicks <= p1.clicks) continue;

    // Must have had meaningful traffic in the oldest period
    if (p3.clicks < 10) continue;

    const totalClickLoss = p3.clicks - p1.clicks;

    let positionTrend: string;
    if (p1.position > p3.position + 2) {
      positionTrend = "Rankings declining";
    } else if (p1.position < p3.position - 2) {
      positionTrend = "Rankings improved but traffic still dropped (possible search demand decline)";
    } else {
      positionTrend = "Rankings stable (possible CTR or demand decline)";
    }

    decaying.push({
      page,
      period1Clicks: p1.clicks,
      period2Clicks: p2.clicks,
      period3Clicks: p3.clicks,
      totalClickLoss,
      period1Position: Math.round(p1.position * 10) / 10,
      period2Position: Math.round(p2.position * 10) / 10,
      period3Position: Math.round(p3.position * 10) / 10,
      positionTrend,
    });
  }

  decaying.sort((a, b) => b.totalClickLoss - a.totalClickLoss);
  return decaying.slice(0, 50);
}

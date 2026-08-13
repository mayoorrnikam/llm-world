/**
 * The context-window frontier, and the step chart that draws it.
 *
 * Extracted so the homepage and /analytics/context-windows/ draw the SAME
 * chart. The alternative was reimplementing it in search.js, and this project
 * has already paid for that mistake once: the company-to-logo map lived in
 * three files, none of them knew about Ai2 or MiniMax, and two labs shipped
 * unbranded. A chart computed twice would disagree the same way — silently,
 * and about numbers.
 *
 * It emits an SVG string rather than DOM, because one of the two callers is a
 * build script with no document. The browser inserts it and the build writes
 * it; neither knows the other exists.
 */

/** Releases that set a new maximum disclosed context window, in order. */
export function contextFrontier(records, contextOf, stampOf) {
  const dated = records
    .filter((r) => contextOf(r) && stampOf(r))
    .sort((a, b) => stampOf(a) - stampOf(b));

  const frontier = [];
  let best = 0;
  for (const r of dated) {
    const v = contextOf(r);
    if (v > best) { best = v; frontier.push(r); }
  }
  return frontier;
}

export const tokenLabel = (n) => (n >= 1e6
  ? `${+(n / 1e6).toFixed(2)}M`
  : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/**
 * A STEP chart, which is the honest encoding for this data.
 *
 * A context window is a level that holds from the day it ships until something
 * larger ships. GPT-4's 8K did not slide toward 128K over 426 days; it held,
 * then jumped. A sloped line would draw a rate of change that never existed
 * between two dated announcements, and bars would imply each release is an
 * independent measurement rather than a level that persisted.
 *
 * Log scale, because 2K to 10M linear flattens everything before 2024 into the
 * baseline.
 */
export function stepChartSvg(frontier, {
  contextOf,
  stampOf,
  labelOf = (r) => r.model,
  dateOf = () => '',
  width = 720,
  height = 300,
  escape = (s) => String(s),
} = {}) {
  if (frontier.length < 2) return '';

  const PAD = { l: 54, r: 16, t: 16, b: 32 };
  const first = frontier[0];
  const last = frontier[frontier.length - 1];

  const t0 = stampOf(first), t1 = stampOf(last);
  const lo = Math.log10(contextOf(first));
  const hi = Math.log10(contextOf(last));

  const x = (r) => PAD.l + (stampOf(r) - t0) / Math.max(1, t1 - t0) * (width - PAD.l - PAD.r);
  const y = (v) => height - PAD.b
    - (Math.log10(v) - lo) / Math.max(0.001, hi - lo) * (height - PAD.t - PAD.b);

  // Across at the old level, then up at the release date.
  let d = `M ${x(first).toFixed(1)} ${y(contextOf(first)).toFixed(1)}`;
  for (let i = 1; i < frontier.length; i++) {
    d += ` L ${x(frontier[i]).toFixed(1)} ${y(contextOf(frontier[i - 1])).toFixed(1)}`;
    d += ` L ${x(frontier[i]).toFixed(1)} ${y(contextOf(frontier[i])).toFixed(1)}`;
  }
  d += ` L ${(width - PAD.r).toFixed(1)} ${y(contextOf(last)).toFixed(1)}`;

  const ticks = [1e3, 1e4, 1e5, 1e6, 1e7]
    .filter((v) => v >= 10 ** lo / 2 && v <= 10 ** hi * 2);

  const grid = ticks.map((v) => `<line x1="${PAD.l}" x2="${width - PAD.r}" y1="${
    y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="cs-grid"/>`
    + `<text x="${PAD.l - 8}" y="${(y(v) + 4).toFixed(1)}" class="cs-tick" text-anchor="end">${
      tokenLabel(v)}</text>`).join('');

  const dots = frontier.map((r) => `<circle cx="${x(r).toFixed(1)}" cy="${
    y(contextOf(r)).toFixed(1)}" r="3.5" class="cs-dot"><title>${
    escape(labelOf(r))} — ${tokenLabel(contextOf(r))}${dateOf(r) ? `, ${escape(dateOf(r))}` : ''}</title></circle>`).join('');

  const years = [...new Set(frontier.map((r) => new Date(stampOf(r)).getUTCFullYear()))];
  const yearMarks = years.map((yr) => {
    const at = frontier.find((r) => new Date(stampOf(r)).getUTCFullYear() === yr);
    return `<text x="${x(at).toFixed(1)}" y="${height - 11}" class="cs-tick" text-anchor="middle">${yr}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" role="img" class="cs-chart"
     aria-label="Frontier context window over time, log scale, as a step chart from ${
       tokenLabel(contextOf(first))} in ${years[0]} to ${tokenLabel(contextOf(last))} in ${
       years[years.length - 1]}.">
${grid}
<path d="${d}" class="cs-step" fill="none"/>
${dots}${yearMarks}
</svg>`;
}

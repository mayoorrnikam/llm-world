/**
 * Finds a usable snapshot of a URL, across more than one public web archive.
 *
 * TWO PROBLEMS, ONE MODULE.
 *
 * 1. ARCHIVE.ORG IS A SINGLE POINT OF FAILURE. It rate-limited this project for
 *    hours after a heavy day, and has since returned HTTP 503 to every request
 *    — lookups included — for long enough that 32 records sat unarchivable.
 *    R1 says cite the snapshot, not the live page, so when the archive is down
 *    the dataset simply cannot meet its own standard.
 *
 * 2. AN ARCHIVED ERROR PAGE IS NOT EVIDENCE. archive.org's availability API
 *    returns the captured HTTP status and nothing here was reading it. Arquivo.pt
 *    holds three captures of openai.com/index/whisper and every one is a 403 —
 *    they archived the bot-block page. A citation to that resolves, renders,
 *    shows an "archived" badge, and evidences nothing. That is the hollow
 *    citation this project already fixed once, arriving through a new door.
 *
 * WHAT IS AND IS NOT HERE
 *
 * archive.org first, because its coverage of these hosts is far better than
 * anything else. Arquivo.pt second: a real CDX API, no key, genuinely useful
 * for older pages, thin on AI labs.
 *
 * archive.today third. An earlier note here said it "answers 429 and publishes
 * no API", and that was wrong on both counts: it serves the Memento TimeMap
 * endpoint — an interoperability standard, not a scrape — and a probe of 20
 * unarchived sources at one request every 2.5s drew 200s and not a single 429.
 * The 429 came from asking too fast, which is a rate to fix, not a refusal.
 * Coverage is about one URL in five, and it holds the Claude Haiku 4.5
 * announcement captured on 2025-10-15, the day Anthropic published it.
 *
 * Memento Time Travel was the obvious pick, since it aggregates many archives
 * at once, and is still not here: both documented endpoints time out.
 *
 * LOOKUP ONLY, DELIBERATELY. archive.org gets save requests because it offers a
 * save endpoint and asks for nothing in return. archive.today is read here and
 * never written to: it publishes no save API, and driving its interactive
 * capture form would be taking a service it has not offered. A 429 is answered
 * by backing off, never by retrying harder.
 *
 * If a fourth archive is added later, it belongs here and nowhere else — the
 * point of this module is that the callers do not learn about archives.
 */

const UA = { 'user-agent': 'llm-world archive lookup' };

/** A capture is only evidence if the archive captured a real page. */
const usable = (status) => status === '200' || status === 200;

async function wayback(url) {
  const res = await fetch(
    `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    { signal: AbortSignal.timeout(20000), headers: UA },
  );
  if (!res.ok) return { error: `archive.org HTTP ${res.status}` };
  const snap = (await res.json())?.archived_snapshots?.closest;
  if (!snap?.available) return {};
  if (!usable(snap.status)) return { rejected: `archive.org captured HTTP ${snap.status}` };
  return { url: snap.url, timestamp: snap.timestamp, via: 'archive.org' };
}

async function arquivo(url) {
  const res = await fetch(
    `https://arquivo.pt/wayback/cdx?url=${encodeURIComponent(url)}&output=json&limit=20`,
    { signal: AbortSignal.timeout(20000), headers: UA },
  );
  if (!res.ok) return { error: `arquivo.pt HTTP ${res.status}` };
  const body = (await res.text()).trim();
  if (!body) return {};
  const rows = body.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((r) => usable(r.status));
  if (!rows.length) return { rejected: 'arquivo.pt holds only error captures' };
  const newest = rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0];
  return {
    url: `https://arquivo.pt/wayback/${newest.timestamp}/${newest.url}`,
    timestamp: String(newest.timestamp).slice(0, 14),
    via: 'arquivo.pt',
  };
}

/**
 * archive.today, through its Memento TimeMap.
 *
 * The TimeMap is link format, one memento per entry:
 *
 *   <http://archive.md/20240620154339/https://…>; rel="memento";
 *     datetime="Thu, 20 Jun 2024 15:43:39 GMT",
 *
 * There is no captured-status field, which is the one thing archive.org's
 * availability API gives that this cannot: a 403 bot-block page captured here
 * is indistinguishable from a real capture. That is why this runs last — the
 * two archives that can prove a capture was a real page get asked first.
 */
async function archiveToday(url) {
  const res = await fetch(`http://archive.ph/timemap/${url}`, {
    signal: AbortSignal.timeout(30000),
    headers: UA,
  });
  // Asking too fast is this project's problem to fix, not the archive's.
  if (res.status === 429) return { error: 'archive.today rate-limited — slow down, do not retry' };
  if (res.status === 404) return {};
  if (!res.ok) return { error: `archive.today HTTP ${res.status}` };

  const mementos = [...(await res.text()).matchAll(
    /<([^>]+)>;\s*rel="[^"]*memento[^"]*";\s*datetime="([^"]+)"/g,
  )];
  if (!mementos.length) return {};

  const [href, when] = mementos[mementos.length - 1].slice(1);
  const t = new Date(when);
  if (Number.isNaN(t.getTime())) return {};
  return {
    url: href,
    timestamp: t.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14),
    via: 'archive.today',
  };
}

/**
 * The newest usable snapshot, or an explanation.
 *
 * Returns `{ url, timestamp, via }` on success. On failure the shape says WHY,
 * because "no snapshot" and "the archive is down" and "the only capture is a
 * 403" are three different situations and a caller that cannot tell them apart
 * will record the wrong reason on the record.
 */
export async function findSnapshot(url, { archives = [wayback, arquivo, archiveToday] } = {}) {
  const notes = [];
  for (const source of archives) {
    try {
      const hit = await source(url);
      if (hit.url) return hit;
      if (hit.error) notes.push(hit.error);
      if (hit.rejected) notes.push(hit.rejected);
    } catch (e) {
      notes.push(e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
  }
  return { notes };
}

/** Exported for tests and for callers that want one archive only. */
export const providers = { wayback, arquivo, archiveToday };

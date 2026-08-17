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
 * Two alternatives were tested and rejected:
 *   - Memento Time Travel, the obvious choice since it aggregates many archives
 *     at once, returned an empty body on both its documented endpoints.
 *   - archive.today answers 429 to an automated request and publishes no API.
 *     Automating around a service that is asking you not to is not a fix.
 *
 * If a third archive is added later, it belongs here and nowhere else — the
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
 * The newest usable snapshot, or an explanation.
 *
 * Returns `{ url, timestamp, via }` on success. On failure the shape says WHY,
 * because "no snapshot" and "the archive is down" and "the only capture is a
 * 403" are three different situations and a caller that cannot tell them apart
 * will record the wrong reason on the record.
 */
export async function findSnapshot(url, { archives = [wayback, arquivo] } = {}) {
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
export const providers = { wayback, arquivo };

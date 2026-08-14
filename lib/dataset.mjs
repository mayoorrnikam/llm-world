/**
 * Writes data/llm-releases.json, refusing if someone else wrote it first.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * Every enrichment script does read-modify-write: parse the whole dataset into
 * memory, change some records, write the whole thing back. Two running at once
 * means the slower one's final write erases everything the faster one did.
 *
 * It happened. `archive-sources --save` was left running in the background —
 * five Save Page Now requests, about two minutes — while `add-model --write`
 * added Shieldstral and LFM2.5. The archive pass had loaded the dataset before
 * those records existed and wrote its copy back over them on exit. Both records
 * vanished.
 *
 * The dangerous part is that nothing caught it. validate, build and smoke all
 * passed, because a dataset missing two records is perfectly valid JSON with
 * perfectly valid records. It was noticed only because a count read 149 where
 * 151 was expected — which is to say, by luck.
 *
 * HOW IT WORKS
 *
 * The stamp is taken when this module is first imported, which is before the
 * script reads the file. Every save re-checks it. A refusal throws, so the run
 * fails loudly and can simply be repeated; the alternative is a silent
 * overwrite nobody finds until a count looks wrong.
 *
 * Size plus mtime rather than a hash, because attribute-facts flushes after
 * every record on purpose — so a run killed by rate limiting is resumable — and
 * re-hashing a multi-megabyte file on each flush would make that expensive.
 */

import { writeFileSync, statSync } from 'node:fs';

export const FILE = 'data/llm-releases.json';

const stampOf = (file) => {
  try {
    const s = statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'absent';
  }
};

let expected = stampOf(FILE);

/** Write the dataset, unless another script changed it since we started. */
export function saveDataset(data, file = FILE) {
  if (stampOf(file) !== expected) {
    throw new Error(
      `\n${file} changed while this script was running — refusing to write.\n\n`
      + `Another script wrote to the dataset after this one read it. Saving now\n`
      + `would erase that work, so nothing has been written.\n\n`
      + `Re-run this script. Do not run two dataset-writing scripts at once.\n`,
    );
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  expected = stampOf(file);
}

/** For add-model and split-record, which write a file they just created. */
export function resyncDataset(file = FILE) {
  expected = stampOf(file);
}

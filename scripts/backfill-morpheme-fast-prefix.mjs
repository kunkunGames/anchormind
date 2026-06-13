#!/usr/bin/env node
/**
 * Fast morpheme backfill for embedding-prefix migrations.
 *
 * Rebuilds agent_memory.morpheme_dict from the current fragments snapshot and
 * marks processed fragments morpheme_indexed=true. This keeps the same local
 * tokenizer and embedding provider as the runtime path, but batches work much
 * more aggressively than the fire-and-forget remember postprocessor path.
 */

import { getPrimaryPool, shutdownPool } from "../lib/tools/db.js";
import {
  generateBatchEmbeddings,
  vectorToSql
} from "../lib/tools/embedding.js";
import { tokenizeLocal } from "../lib/memory/embedding/MorphemeTokenizer.js";
import { MEMORY_CONFIG } from "../config/memory.js";

const SCHEMA         = "agent_memory";
const FRAGMENT_BATCH = parseInt(process.env.MORPHEME_BACKFILL_FRAGMENT_BATCH || "2000", 10);
const EMBED_BATCH    = parseInt(process.env.MORPHEME_BACKFILL_EMBED_BATCH || "200", 10);
const INSERT_BATCH   = parseInt(process.env.MORPHEME_BACKFILL_INSERT_BATCH || "100", 10);
const UPDATE_BATCH   = parseInt(process.env.MORPHEME_BACKFILL_UPDATE_BATCH || "2000", 10);
const MAX_MORPHEMES  = MEMORY_CONFIG.morphemeIndex?.maxMorphemes || 10;

function now() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`${now()} ${message}`);
}

async function embedWithSplit(items, batchSize = EMBED_BATCH) {
  if (items.length === 0) return [];
  try {
    return await generateBatchEmbeddings(items, batchSize);
  } catch (err) {
    if (items.length === 1) {
      console.warn(`${now()} [embed] failed token="${items[0]}" err=${err.message}`);
      return [null];
    }
    const mid = Math.ceil(items.length / 2);
    const left = await embedWithSplit(items.slice(0, mid), Math.max(1, Math.floor(batchSize / 2)));
    const right = await embedWithSplit(items.slice(mid), Math.max(1, Math.floor(batchSize / 2)));
    return left.concat(right);
  }
}

async function insertVectors(pool, pairs) {
  for (let i = 0; i < pairs.length; i += INSERT_BATCH) {
    const batch = pairs.slice(i, i + INSERT_BATCH);
    const placeholders = [];
    const params = [];
    let p = 1;

    for (const [morpheme, vector] of batch) {
      placeholders.push(`($${p}, $${p + 1}::vector)`);
      params.push(morpheme, vectorToSql(vector));
      p += 2;
    }

    await pool.query(
      `INSERT INTO ${SCHEMA}.morpheme_dict (morpheme, embedding)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (morpheme) DO NOTHING`,
      params
    );
  }
}

async function updateIndexed(pool, ids) {
  for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
    const batch = ids.slice(i, i + UPDATE_BATCH);
    await pool.query(
      `UPDATE ${SCHEMA}.fragments
       SET morpheme_indexed = true
       WHERE id = ANY($1::text[])`,
      [batch]
    );
  }
}

async function main() {
  const pool = getPrimaryPool();
  const started = Date.now();

  try {
    log("[reset] truncating morpheme_dict and clearing morpheme_indexed");
    await pool.query(`TRUNCATE ${SCHEMA}.morpheme_dict`);
    await pool.query(`UPDATE ${SCHEMA}.fragments SET morpheme_indexed = false`);

    const { rows } = await pool.query(
      `SELECT id, content
       FROM ${SCHEMA}.fragments
       ORDER BY id`
    );
    const ids = rows.map(r => r.id);
    log(`[snapshot] fragments=${rows.length} maxMorphemes=${MAX_MORPHEMES}`);

    const unique = new Set();
    for (let i = 0; i < rows.length; i += FRAGMENT_BATCH) {
      const batch = rows.slice(i, i + FRAGMENT_BATCH);
      for (const row of batch) {
        const tokens = await tokenizeLocal(row.content || "", MAX_MORPHEMES);
        for (const token of tokens) {
          if (typeof token === "string" && token.trim()) unique.add(token);
        }
      }
      log(`[tokenize] processed=${Math.min(i + batch.length, rows.length)}/${rows.length} unique=${unique.size}`);
    }

    const morphemes = [...unique].sort();
    log(`[embed] unique_morphemes=${morphemes.length} embedBatch=${EMBED_BATCH}`);

    let inserted = 0;
    for (let i = 0; i < morphemes.length; i += EMBED_BATCH) {
      const batch = morphemes.slice(i, i + EMBED_BATCH);
      const vectors = await embedWithSplit(batch, EMBED_BATCH);
      const pairs = [];
      for (let j = 0; j < batch.length; j++) {
        if (vectors[j]) pairs.push([batch[j], vectors[j]]);
      }
      await insertVectors(pool, pairs);
      inserted += pairs.length;
      log(`[embed] processed=${Math.min(i + batch.length, morphemes.length)}/${morphemes.length} inserted=${inserted}`);
    }

    await updateIndexed(pool, ids);
    const counts = await pool.query(
      `SELECT
         (SELECT count(*) FROM ${SCHEMA}.fragments) AS total,
         (SELECT count(*) FROM ${SCHEMA}.fragments WHERE morpheme_indexed = true) AS indexed,
         (SELECT count(*) FROM ${SCHEMA}.morpheme_dict) AS dict_count`
    );
    log(`[done] total=${counts.rows[0].total} indexed=${counts.rows[0].indexed} dict=${counts.rows[0].dict_count} elapsed_ms=${Date.now() - started}`);
  } finally {
    await shutdownPool();
  }
}

main().catch(err => {
  console.error(`${now()} [fatal] ${err.stack || err.message}`);
  process.exitCode = 1;
});

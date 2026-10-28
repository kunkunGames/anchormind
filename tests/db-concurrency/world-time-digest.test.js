/**
 * 세계 시각, 상태 표지, 묶음 요약 실서버 시험(일회용 DB)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-12
 *
 * 마이그레이션 065, 066을 적용한 전용 데이터베이스에서 다음을 본다.
 *   1. remember와 batch_remember가 mention_time과 본문에서 뽑은 event_time을 저장하고 amend가 고친다
 *   2. timeRange basis=event가 세계 시각으로 거른다
 *   3. 충돌 표지가 양쪽에 붙고 이전 값이 대체한 파편 뒤에 끼워진다
 *   4. build_digests가 시간선과 선호 목록을 만들고, 출처가 닫히면 읽기에서 빠지며 다음 주기에 지워진다
 */

import crypto                        from "node:crypto";
import { describe, it, before, after } from "node:test";
import assert                        from "node:assert/strict";

process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";

const { prepareLaneDatabase, dropLaneDatabase, directQuery, SCHEMA } = await import("./_harness.js");

/** 앱 모듈이 풀을 만들기 전에 실행 전용 데이터베이스를 준비한다. */
await prepareLaneDatabase();

const { shutdownPool }          = await import("../../lib/tools/db.js");
const { MemoryManager }         = await import("../../lib/memory/MemoryManager.js");
const { FragmentStore }         = await import("../../lib/memory/write/FragmentStore.js");
const { annotateFragmentState } = await import("../../lib/memory/read/FragmentStateLoader.js");
const { buildDigests }          = await import("../../lib/memory/consolidate/DigestBuilder.js");
const { loadDigests }           = await import("../../lib/memory/read/DigestLoader.js");

const RUN = `wt-${crypto.randomBytes(4).toString("hex")}`;
const KEY = `${RUN}-key`;
const WS  = `${RUN}-ws`;
const mm  = new MemoryManager();

const ctx = { _keyId: KEY, _groupKeyIds: [KEY], workspace: WS, agentId: "default" };

async function row(id) {
  const { rows } = await directQuery(
    `SELECT mention_time, event_time, event_time_end, event_time_precision FROM ${SCHEMA}.fragments WHERE id = $1`, [id]);
  return rows[0];
}

async function insertFragment(id, content, { topic = `${RUN}-t`, type = "fact", mention = null } = {}) {
  await directQuery(
    `INSERT INTO ${SCHEMA}.fragments (id, content, topic, type, importance, ttl_tier, agent_id, keywords, content_hash,
                                      key_id, workspace, mention_time)
     VALUES ($1, $2, $3, $4, 0.5, 'warm', 'default', '{}', md5($1), $5, $6, $7)`,
    [id, content, topic, type, KEY, WS, mention]
  );
  return id;
}

before(async () => {
  await directQuery(
    `INSERT INTO ${SCHEMA}.api_keys (id, name, key_hash, key_prefix) VALUES ($1, $1, md5($1), left($1, 8))`, [KEY]);
});

after(async () => {
  try {
    await shutdownPool();
  } finally {
    await dropLaneDatabase();
  }
});

describe("세계 시각 저장과 거르기", () => {
  it("remember가 말한 시각과 본문 날짜 표현의 사건 시각을 저장하고 amend가 고친다", async () => {
    const res = await mm.remember({ ...ctx, content: `${RUN} 서버를 지난주에 이전했다`, topic: `${RUN}-t`, type: "fact",
      mentionTime: "2023-05-20T02:21:00Z" });
    const saved = await row(res.id);
    assert.equal(saved.mention_time.toISOString(), "2023-05-20T02:21:00.000Z");
    assert.equal(saved.event_time.toISOString(), "2023-05-08T00:00:00.000Z");
    assert.equal(saved.event_time_precision, "week");

    const amended = await mm.amend({ ...ctx, id: res.id, eventTime: "2023-04" });
    assert.equal(amended.updated, true);
    const after = await row(res.id);
    assert.equal(after.event_time.toISOString(), "2023-04-01T00:00:00.000Z");
    assert.equal(after.event_time_precision, "month");
    assert.equal(after.mention_time.toISOString(), "2023-05-20T02:21:00.000Z");
  });

  it("batch_remember가 항목별 세계 시각을 저장하고 해석 경고를 그 항목에 싣는다", async () => {
    const out = await mm.batchRemember({ ...ctx, fragments: [
      { content: `${RUN} 배치 2024-03-14 출시`, topic: `${RUN}-b`, type: "fact" },
      { content: `${RUN} 배치 날짜 없음`, topic: `${RUN}-b`, type: "fact", mentionTime: "2024-01-01T00:00:00Z" },
      { content: `${RUN} 배치 잘못된 시각`, topic: `${RUN}-b`, type: "fact", eventTime: "nope" }
    ] });
    assert.equal(out.inserted, 3);
    assert.equal((await row(out.results[0].id)).event_time.toISOString(), "2024-03-14T00:00:00.000Z");
    assert.equal((await row(out.results[1].id)).mention_time.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.deepEqual(out.results[2].validation_warnings, ["eventTimeInvalid"]);
  });

  it("timeRange basis=event는 세계 시각으로, 기본은 저장 시각으로 거른다", async () => {
    const id = await insertFragment(`${RUN}-tr`, `${RUN} 지난 일`, { mention: "2022-02-02T00:00:00Z" });
    const store = new FragmentStore();
    const opts  = { agentId: "default", keyId: KEY, workspace: WS, limit: 50 };
    const byEvent   = await store.searchByTimeRange(new Date("2022-02-01"), new Date("2022-02-03"), { ...opts, timeBasis: "event" });
    const byCreated = await store.searchByTimeRange(new Date("2022-02-01"), new Date("2022-02-03"), opts);
    assert.ok(byEvent.some(f => f.id === id));
    assert.ok(!byCreated.some(f => f.id === id));
  });
});

describe("상태 표지", () => {
  it("충돌 표지는 양쪽에, 이전 값은 대체한 파편 뒤에 붙는다", async () => {
    const a   = await insertFragment(`${RUN}-a`, `${RUN} port 8080`);
    const b   = await insertFragment(`${RUN}-b`, `${RUN} port 9090`);
    const old = await insertFragment(`${RUN}-old`, `${RUN} port 7070`);
    await directQuery(`UPDATE ${SCHEMA}.fragments SET valid_to = NOW() WHERE id = $1`, [old]);
    await directQuery(
      `INSERT INTO ${SCHEMA}.fragment_links (from_id, to_id, relation_type) VALUES ($1, $2, 'contradicts'), ($3, $1, 'superseded_by')`,
      [a, b, old]);
    const scope = { agentId: "default", keyId: KEY, groupKeyIds: [KEY], workspace: WS };
    const out = await annotateFragmentState([{ id: a }, { id: b }], scope, { includeHistory: true });
    assert.deepEqual(out.map(f => [f.id, f.state]), [[a, "conflict"], [old, "superseded"], [b, "conflict"]]);
    assert.deepEqual(out[0].conflicts_with, [b]);
    assert.deepEqual(out[2].conflicts_with, [a]);
  });
});

describe("묶음 요약", () => {
  it("시간선과 선호 목록을 만들고, 출처가 닫히면 읽기에서 빠지고 다음 주기에 지워진다", async () => {
    const topic = `${RUN}-dg`;
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await insertFragment(`${RUN}-dg${i}`, `${RUN} 일정 ${i}`, { topic, mention: `2024-0${i + 1}-01T00:00:00Z` }));
    }
    await insertFragment(`${RUN}-p1`, `${RUN} 커피를 좋아한다`, { topic: `${RUN}-pref`, type: "preference", mention: "2024-01-01T00:00:00Z" });
    await insertFragment(`${RUN}-p2`, `${RUN} 차를 좋아한다`, { topic: `${RUN}-pref`, type: "preference", mention: "2024-06-01T00:00:00Z" });

    const first = await buildDigests();
    assert.equal(first.status, "ok");
    const scope = { agentId: "default", keyId: KEY, workspace: WS };
    const got = await loadDigests(scope, { topics: [topic], preference: true });
    const timeline = got.find(d => d.kind === "topic_timeline");
    const profile  = got.find(d => d.kind === "preference_profile");
    assert.equal(timeline.item_count, 5);
    assert.match(timeline.content, /^\[timeline\] /);
    assert.ok(timeline.content.indexOf("일정 0") < timeline.content.indexOf("일정 4"));
    assert.equal(profile.content.split("\n")[1].endsWith("차를 좋아한다"), true);

    await directQuery(`UPDATE ${SCHEMA}.fragments SET valid_to = NOW() WHERE id = $1`, [ids[0]]);
    const afterClose = await loadDigests(scope, { topics: [topic], preference: false });
    assert.equal(afterClose.length, 0);

    await buildDigests();
    const { rows } = await directQuery(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.fragment_digest WHERE kind = 'topic_timeline' AND subject = $1`, [topic]);
    assert.equal(rows[0].n, 0);
  });
});

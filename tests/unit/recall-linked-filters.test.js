/**
 * recall 연결 파편의 파편 조건 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-13
 *
 * 1. 연결 파편 SQL은 recall의 type, topic, caseId, resolutionStatus, phase, affect, minImportance 조건을
 *    두 방향 조회에 모두 넣고, 출발 파편 ID(linked_from)를 돌려준다.
 * 2. MemoryRecaller는 같은 조건을 저장소에 넘기고, 저장소가 조건을 지키지 않은 행도 결과에 넣지 않는다.
 */

import { describe, it, mock } from "node:test";
import assert                            from "node:assert/strict";

mock.module("../../lib/redis.js", {
  namedExports: { redisClient: { status: "stub" } }
});
mock.module("../../lib/logger.js", {
  namedExports: { logDebug: mock.fn(), logInfo: mock.fn(), logWarn: mock.fn(), logError: mock.fn() }
});
mock.module("../../lib/memory/signals/SearchMetrics.js", {
  namedExports: { getSearchMetrics: async () => ({ record: async () => {} }) }
});
mock.module("../../lib/memory/signals/SearchParamAdaptor.js", {
  namedExports: { getSearchParamAdaptor: () => ({ getMinSimilarity: async () => null }) }
});
mock.module("../../lib/memory/read/SearchSideEffects.js", {
  namedExports: { commitSearchSideEffects: async () => "event-1" }
});
mock.module("../../lib/memory/read/Reranker.js", {
  namedExports: { isRerankerAvailable: () => false, rerank: async () => null }
});

const { LinkStore, linkedFieldFilter }  = await import("../../lib/memory/link/LinkStore.js");
const { FragmentSearch }                = await import("../../lib/memory/read/FragmentSearch.js");
const { MemoryRecaller, recallFragmentFilters } = await import("../../lib/memory/processors/MemoryRecaller.js");

const FILTERS = {
  type: "error", topic: "memento-mcp", caseId: "debug-x", resolutionStatus: "open",
  phase: "debugging", affect: ["frustration"], minImportance: 0.5
};

describe("연결 파편 SQL 조건", () => {
  it("조건마다 두 방향 조회에 같은 바인딩을 쓴다", () => {
    const { sql, params } = new LinkStore()._buildLinkedFragmentsSql({
      fromIds: ["seed"], safeRelationType: null, keyId: null, allWorkspaces: true, filters: FILTERS
    });
    for (const [column, value] of [
      ["type", "error"], ["topic", "memento-mcp"], ["case_id", "debug-x"], ["resolution_status", "open"], ["phase", "debugging"]
    ]) {
      const n = params.indexOf(value) + 1;
      assert.ok(n > 0, column);
      assert.equal(sql.split(`f.${column} = $${n}`).length - 1, 2, column);
    }
    assert.equal(sql.split(`f.affect = ANY($${params.findIndex(p => Array.isArray(p) && p[0] === "frustration") + 1})`).length - 1, 2);
    assert.equal(sql.split(`f.importance >= $${params.indexOf(0.5) + 1}`).length - 1, 2);
    assert.match(sql, /l\.from_id AS linked_from/);
    assert.match(sql, /l\.to_id AS linked_from/);
  });

  it("조건이 없으면 SQL과 바인딩을 더하지 않는다", () => {
    const params = [];
    assert.equal(linkedFieldFilter(params, { type: undefined, topic: "", affect: [] }), "");
    assert.deepEqual(params, []);
  });

  it("recall 인자의 topic 공백을 검색과 같이 정리한다", () => {
    assert.equal(recallFragmentFilters({ topic: "  memento-mcp " }).topic, "memento-mcp");
    assert.equal(recallFragmentFilters({ topic: "   " }).topic, undefined);
    assert.deepEqual(Object.keys(recallFragmentFilters({})).sort(), ["minImportance", "topic", "type"]);
  });
});

function buildRecaller(linkedRows) {
  const search = new FragmentSearch();
  search._executeSearch = async () => ({
    combined: [{
      id: "seed", content: "deploy failure root cause", topic: "memento-mcp", keywords: ["deploy"],
      type: "error", resolution_status: "open", importance: 0.8, created_at: new Date().toISOString(),
      agent_id: "default", workspace: null, estimated_tokens: 10
    }],
    searchPath  : ["L2:1"],
    l1IsFallback: false,
    layerLatency: { l1Ms: 0, l2Ms: 0, l3Ms: 0, graphUsed: false }
  });
  search.store = { incrementAccess: () => {}, touchLinked: async () => {} };
  search._cacheFragments = async () => {};

  const calls = [];
  const store = {
    getLinkedFragments: async (fromIds, _rel, _agent, _keys, opts) => {
      calls.push(opts.filters ?? {});
      return linkedRows.map(r => ({ ...r }));
    }
  };
  const recaller = new MemoryRecaller({
    search, store,
    index           : { getSeenIds: async () => new Set() },
    suggestionEngine: { suggest: async () => null }
  });
  return { recaller, calls };
}

describe("MemoryRecaller 연결 파편 조건", () => {
  const base = { agent_id: "default", workspace: null, importance: 0.7, created_at: new Date().toISOString(), topic: "memento-mcp", estimated_tokens: 10 };
  const rows = [
    { ...base, id: "ok",       content: "linked error", type: "error",    resolution_status: "open", linked_from: "seed" },
    { ...base, id: "decision", content: "linked decision", type: "decision", resolution_status: "open", linked_from: "seed" },
    { ...base, id: "closed",   content: "linked closed", type: "error",    resolution_status: "resolved", linked_from: "seed" }
  ];

  it("조건을 넘기고 맞지 않는 행은 버린다", async () => {
    const { recaller, calls } = buildRecaller(rows);
    const result = await recaller.recall({ keywords: ["deploy"], type: "error", resolutionStatus: "open", tokenBudget: 5000 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "error");
    assert.equal(calls[0].resolutionStatus, "open");
    const ids = result.fragments.map(f => f.id).sort();
    assert.deepEqual(ids, ["ok", "seed"]);
    const linked = result.fragments.find(f => f.id === "ok");
    assert.equal(linked.recall_source, "linked");
    assert.equal(linked.linked_from, "seed");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";

/** 순수 함수로 추출된 컷오프 로직 검증 */
import { applyImportanceCutoff } from "../../lib/memory/read/FragmentSearch.js";

test("low-importance non-anchor fragments are cut", () => {
  const frags = [
    { id: "a", importance: 0.05, is_anchor: false },
    { id: "b", importance: 0.80, is_anchor: false },
    { id: "c", importance: 0.02, is_anchor: true },        // anchor는 보존
    { id: "d", is_anchor: false },                          // L1-only(importance undefined)는 보존
  ];
  const out = applyImportanceCutoff(frags, 0.15, undefined);
  assert.deepEqual(out.map(f => f.id), ["b", "c", "d"]);
});

test("explicit minImportance overrides default cutoff", () => {
  const frags = [{ id: "a", importance: 0.20, is_anchor: false }];
  const out = applyImportanceCutoff(frags, 0.15, 0.5);  // 명시 0.5 우선
  assert.deepEqual(out.map(f => f.id), []);
});

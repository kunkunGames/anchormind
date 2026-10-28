/**
 * workspace 없는 저장 호출 판정 시험
 *
 * 작성자: 최진호
 * 작성일: 2026-10-13
 */

import { describe, it, afterEach } from "node:test";
import assert                      from "node:assert/strict";

process.env.DOTENV_CONFIG_PATH      ??= ".env.test";
process.env.MEMENTO_METRICS_DEFAULT ??= "off";

const { isWorkspaceMissing, checkMissingWorkspace, withWorkspaceWarning, WORKSPACE_MISSING } =
  await import("../../lib/tools/workspace-missing.js");

afterEach(() => {
  delete process.env.MEMENTO_MISSING_WORKSPACE;
});

describe("isWorkspaceMissing", () => {
  it("인자나 키 기본값에 workspace가 있으면 누락이 아니다", () => {
    assert.equal(isWorkspaceMissing("remember", { workspace: "memento-mcp" }), false);
    assert.equal(isWorkspaceMissing("reflect", { _defaultWorkspace: "memento-mcp" }), false);
  });

  it("빈 문자열과 공백은 없는 것으로 본다", () => {
    assert.equal(isWorkspaceMissing("remember", { workspace: "  ", _defaultWorkspace: "" }), true);
  });

  it("scope=session remember는 영구 저장이 아니므로 제외한다", () => {
    assert.equal(isWorkspaceMissing("remember", { scope: "session" }), false);
  });

  it("batch_remember는 workspace 없는 항목이 있을 때만 누락이다", () => {
    assert.equal(isWorkspaceMissing("batch_remember", { fragments: [{ workspace: "a" }, { workspace: "b" }] }), false);
    assert.equal(isWorkspaceMissing("batch_remember", { fragments: [{ workspace: "a" }, {}] }), true);
  });
});

describe("checkMissingWorkspace 정책", () => {
  it("기본(warn)은 경고를 돌려준다", () => {
    assert.equal(checkMissingWorkspace("reflect", {}).code, WORKSPACE_MISSING);
  });

  it("reject는 -32602로 거부한다", () => {
    process.env.MEMENTO_MISSING_WORKSPACE = "reject";
    assert.throws(() => checkMissingWorkspace("remember", {}), (e) => e.code === -32602 && /workspace is not set/.test(e.message));
    assert.equal(checkMissingWorkspace("remember", { workspace: "a" }), null);
  });

  it("allow는 아무것도 하지 않는다", () => {
    process.env.MEMENTO_MISSING_WORKSPACE = "allow";
    assert.equal(checkMissingWorkspace("remember", {}), null);
  });
});

describe("withWorkspaceWarning", () => {
  it("기존 _meta를 지키고 warnings에 더한다", () => {
    const w   = { code: WORKSPACE_MISSING, message: "m" };
    const out = withWorkspaceWarning({ success: true, _meta: { hints: [1], warnings: [{ code: "x" }] } }, w);
    assert.deepEqual(out._meta.hints, [1]);
    assert.deepEqual(out._meta.warnings.map(x => x.code), ["x", WORKSPACE_MISSING]);
    const same = { success: true };
    assert.equal(withWorkspaceWarning(same, null), same);
  });
});

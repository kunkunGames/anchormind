/**
 * BatchRememberWorker 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-06-15
 *
 * 검증 범위:
 *  - _processJob 이 BatchRememberProcessor.process()에 위임한다
 *  - 큐에서 꺼낸 job params 가 그대로 process()로 전달된다
 *  - process() 예외를 삼키지 않고 로깅 후 다음 job으로 진행 (워커 생존)
 *  - start()/stop() drain 이 깨끗하게 동작한다
 */

import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";

import { BatchRememberWorker } from "../../lib/memory/BatchRememberWorker.js";
import { disconnectRedis } from "../../lib/redis.js";

after(async () => { await disconnectRedis().catch(() => {}); });

describe("BatchRememberWorker", () => {
  it("_processJob 이 BatchRememberProcessor.process()에 job.params 를 위임한다", async () => {
    const processedParams = [];
    const mockProcessor = {
      process: mock.fn(async (params) => {
        processedParams.push(params);
        return { results: [], inserted: 1, skipped: 0 };
      })
    };

    const worker = new BatchRememberWorker(mockProcessor);

    const job = {
      jobId : "brw-test-001",
      params: {
        fragments: [{ content: "queued fact", topic: "t", type: "fact" }],
        _keyId   : null,
        agentId  : "test-agent"
      }
    };

    await worker._processJob(job);

    assert.equal(mockProcessor.process.mock.calls.length, 1);
    assert.deepEqual(processedParams[0], job.params);
  });

  it("process() 예외를 삼키지 않고 처리 후 워커가 생존한다", async () => {
    const mockProcessor = {
      process: mock.fn(async () => { throw new Error("insert failed"); })
    };
    const worker = new BatchRememberWorker(mockProcessor);

    /** _processJob 은 내부에서 예외를 로깅하지만 throw하지 않아야 루프가 죽지 않는다. */
    await assert.doesNotReject(() =>
      worker._processJob({ jobId: "brw-err", params: { fragments: [] } })
    );
    assert.equal(mockProcessor.process.mock.calls.length, 1);
  });

  it("start() 후 running=true, stop() 후 running=false 로 깨끗하게 drain", async () => {
    const mockProcessor = {
      process: mock.fn(async () => ({ results: [], inserted: 0, skipped: 0 }))
    };
    const worker = new BatchRememberWorker(mockProcessor);

    await worker.start();
    assert.equal(worker.running, true);

    await worker.stop();
    assert.equal(worker.running, false);
  });

  it("실행 중이 아닐 때 stop() 은 즉시 resolve", async () => {
    const worker = new BatchRememberWorker({ process: mock.fn() });
    await assert.doesNotReject(() => worker.stop());
  });
});

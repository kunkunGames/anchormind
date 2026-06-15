/**
 * BatchRememberWorker -- batch_remember 비동기 큐 처리 워커
 *
 * 작성자: 최진호
 * 작성일: 2026-06-15
 *
 * Redis 큐(memento:batch_remember_queue)를 폴링하여 적재된 job을
 * BatchRememberProcessor.process()에 위임한다. INSERT 본처리는 기존
 * 동기 경로를 그대로 재사용하며, 워커는 큐 소비와 위임만 담당한다.
 *
 * MemoryEvaluator 워커 구조(running 플래그, _drainResolve drain Promise,
 * while 폴링 루프, exponential backoff)를 동일하게 따른다.
 */

import { popFromQueue }   from "../redis.js";
import { MEMORY_CONFIG }  from "../../config/memory.js";
import { logInfo, logWarn, logError } from "../logger.js";

export class BatchRememberWorker {
  /**
   * @param {import("./BatchRememberProcessor.js").BatchRememberProcessor} processor
   */
  constructor(processor) {
    this.processor     = processor;
    this.running       = false;
    this.interval      = MEMORY_CONFIG.batchRememberWorker.intervalMs;
    this._backoff      = 1000;
    this._backoffMax   = 60000;
    this._drainResolve = null;
  }

  /**
   * 워커 시작
   */
  async start() {
    if (this.running) return;
    this.running = true;
    logInfo("[BatchRememberWorker] Worker started");
    this._loop();
  }

  /**
   * 워커 중지 — 현재 job 처리 완료까지 대기하는 Promise 반환
   *
   * @returns {Promise<void>} 루프가 종료되면 resolve
   */
  stop() {
    if (!this.running) return Promise.resolve();

    this.running = false;
    logInfo("[BatchRememberWorker] Worker stopping, waiting for current job to finish...");
    return new Promise(resolve => {
      this._drainResolve = resolve;
    });
  }

  /**
   * 메인 폴링 루프
   *
   * @private
   */
  async _loop() {
    const queueName = MEMORY_CONFIG.batchRememberWorker.queueKey.replace(/^memento:/, "");

    while (this.running) {
      try {
        const job = await popFromQueue(queueName);
        if (job) {
          await this._processJob(job);
          this._backoff = 1000;
        } else {
          await new Promise(resolve => setTimeout(resolve, this.interval));
        }
      } catch (err) {
        logError("[BatchRememberWorker] Error in loop:", err);
        await new Promise(resolve => setTimeout(resolve, this._backoff));
        this._backoff = Math.min(this._backoff * 2, this._backoffMax);
        logWarn(`[BatchRememberWorker] Backing off, next delay: ${this._backoff}ms`);
        continue;
      }
    }

    logInfo("[BatchRememberWorker] Worker stopped");
    if (this._drainResolve) {
      this._drainResolve();
      this._drainResolve = null;
    }
  }

  /**
   * 큐에서 꺼낸 단일 job을 BatchRememberProcessor.process()에 위임한다.
   *
   * @param {{ jobId: string, params: Object }} job
   */
  async _processJob(job) {
    const { jobId, params } = job;
    try {
      const result = await this.processor.process(params);
      logInfo(`[BatchRememberWorker] Job ${jobId} done: inserted=${result.inserted}, skipped=${result.skipped}`);
    } catch (err) {
      logWarn(`[BatchRememberWorker] Job ${jobId} failed: ${err.message}`);
    }
  }
}

/** 싱글톤 */
let workerInstance = null;

/**
 * BatchRememberWorker 싱글톤을 반환한다.
 * 최초 호출 시 processor가 필요하며, 이후 호출은 기존 인스턴스를 반환한다.
 *
 * @param {import("./BatchRememberProcessor.js").BatchRememberProcessor|null} [processor]
 * @returns {BatchRememberWorker}
 */
export function getBatchRememberWorker(processor = null) {
  if (!workerInstance) {
    workerInstance = new BatchRememberWorker(processor);
  }
  return workerInstance;
}

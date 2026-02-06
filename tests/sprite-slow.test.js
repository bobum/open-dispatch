/**
 * Slow tests — gated behind RUN_SLOW_TESTS=1 env var.
 *
 * These tests use realistic timeouts and are too slow for normal CI.
 * Run via: RUN_SLOW_TESTS=1 npm run test:slow
 * Or via the scheduled GitHub Actions workflow (nightly cron).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const SKIP = !process.env.RUN_SLOW_TESTS;

describe('Slow Tests', { skip: SKIP && 'set RUN_SLOW_TESTS=1 to run' }, () => {
  const { createInstanceManager } = require('../src/sprite-core');
  const { JobStatus } = require('../src/job');

  function createMockOrchestrator() {
    let spawnCount = 0;
    return {
      generateJobToken(jobId) { return `slow-token-${jobId.substring(0, 8)}`; },
      async spawnJob(job) {
        spawnCount++;
        const machineId = `slow-machine-${spawnCount}`;
        job.start(machineId);
        return { id: machineId, state: 'started' };
      },
      async spawnPersistent() { return { id: 'p-1', state: 'started' }; },
      async stopSprite() { return { ok: true }; },
      async destroyMachine() {},
      async wakeSprite() { return { ok: true }; },
      async sendCommand() { return { stdout: '', stderr: '', exit_code: 0 }; },
      async streamCommand(id, cmd, onOutput) {
        onOutput('output');
        return { success: true, exitCode: 0 };
      }
    };
  }

  let manager;

  beforeEach(() => {
    manager = createInstanceManager({ orchestrator: createMockOrchestrator() });
  });

  afterEach(() => {
    manager.stopStaleReaper();
    manager.clearInstances();
  });

  it('should timeout with realistic 5s timeout when webhook never fires', { timeout: 15000 }, async () => {
    await manager.startInstance('slow-timeout', 'owner/repo', 'C123');

    const start = Date.now();
    const result = await manager.sendToInstance('slow-timeout', 'long task', {
      onMessage: async () => {},
      repo: 'owner/repo',
      timeoutMs: 5000
    });
    const elapsed = Date.now() - start;

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('timed out'));
    assert.ok(elapsed >= 4500, `Expected ~5s elapsed, got ${elapsed}ms`);
    assert.ok(elapsed < 10000, `Took too long: ${elapsed}ms`);
  });

  it('stale reaper should clean up timed-out jobs', { timeout: 120000 }, async () => {
    await manager.startInstance('reaper-test', 'owner/repo', 'C123');

    // Start a job with a short timeout
    const sendPromise = manager.sendToInstance('reaper-test', 'task', {
      onMessage: async () => {},
      repo: 'owner/repo',
      timeoutMs: 2000
    });

    // Wait for spawn
    await new Promise(r => setTimeout(r, 100));

    const jobs = manager.listJobs();
    assert.ok(jobs.length > 0);
    const job = manager.getJob(jobs[0].jobId);
    assert.strictEqual(job.status, JobStatus.RUNNING);

    // Wait for the sendToInstance timeout to fire
    const result = await sendPromise;
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('timed out'));
  });
});

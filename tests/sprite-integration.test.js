/**
 * Integration test: Full Sprite lifecycle
 *
 * Simulates the complete flow:
 * 1. Start webhook server
 * 2. Create sprite-core instance manager with mocked orchestrator
 * 3. Start an instance, send a task
 * 4. Simulate Sprite POSTing to webhook endpoints (logs, status, artifacts)
 * 5. Verify the sendToInstance Promise resolves with correct data
 *
 * No external services needed — everything runs in-process.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createWebhookServer } = require('../src/webhook-server');
const { createInstanceManager } = require('../src/sprite-core');
const { JobStatus } = require('../src/job');

function post(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST', headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('Sprite Integration', () => {
  let manager;
  let webhookServer;
  let port;

  // Mock orchestrator that captures spawned jobs
  function createMockOrchestrator() {
    let spawnedJobs = [];
    return {
      spawnedJobs: () => spawnedJobs,
      generateJobToken(jobId) {
        return `integration-token-${jobId.substring(0, 8)}`;
      },
      async spawnJob(job) {
        spawnedJobs.push(job);
        const machineId = `machine-${spawnedJobs.length}`;
        job.start(machineId);
        return { id: machineId, state: 'started' };
      },
      async spawnPersistent(options) {
        return { id: 'persistent-1', state: 'started' };
      },
      async stopSprite() { return { ok: true }; },
      async destroyMachine() {},
      async wakeSprite() { return { ok: true }; },
      async sendCommand() { return { stdout: '', stderr: '', exit_code: 0 }; },
      async streamCommand(machineId, command, onOutput) {
        onOutput('persistent output');
        return { success: true, exitCode: 0 };
      }
    };
  }

  beforeEach(async () => {
    const orchestrator = createMockOrchestrator();
    manager = createInstanceManager({ orchestrator });

    // Wire up webhook server with the same jobs map
    webhookServer = createWebhookServer({ jobs: manager.jobs, port: 0 });
    await new Promise((resolve, reject) => {
      webhookServer.server.listen(0, () => {
        port = webhookServer.server.address().port;
        resolve();
      });
      webhookServer.server.on('error', reject);
    });
  });

  afterEach(async () => {
    manager.stopStaleReaper();
    manager.clearInstances();
    await new Promise(resolve => webhookServer.server.close(resolve));
  });

  it('full one-shot lifecycle: spawn → logs → artifacts → status → resolve', async () => {
    // 1. Start instance
    await manager.startInstance('integration-test', 'owner/repo', 'C123');

    // 2. Send task (this creates a Job and spawns a Machine)
    const chatMessages = [];
    const sendPromise = manager.sendToInstance('integration-test', 'run the tests', {
      onMessage: async (text) => { chatMessages.push(text); }
    });

    // 3. Give spawn a moment
    await new Promise(r => setTimeout(r, 50));

    // 4. Find the job
    const jobs = manager.listJobs();
    assert.strictEqual(jobs.length, 1, 'Should have one job');
    const jobId = jobs[0].jobId;
    const job = manager.getJob(jobId);
    assert.ok(job, 'Job should exist');
    assert.strictEqual(job.status, JobStatus.RUNNING);
    assert.ok(job.jobToken, 'Job should have a token');

    const token = job.jobToken;

    // 5. Simulate Sprite posting logs
    const logRes1 = await post(port, '/webhooks/logs', { jobId, text: 'Cloning repo...' }, token);
    assert.strictEqual(logRes1.status, 200);

    const logRes2 = await post(port, '/webhooks/logs', { jobId, text: 'Running tests...' }, token);
    assert.strictEqual(logRes2.status, 200);

    const logRes3 = await post(port, '/webhooks/logs', { jobId, text: 'All 42 tests passed' }, token);
    assert.strictEqual(logRes3.status, 200);

    // Verify logs were appended
    assert.strictEqual(job.logs.length, 3);
    assert.strictEqual(job.logs[0].message, 'Cloning repo...');
    assert.strictEqual(job.logs[2].message, 'All 42 tests passed');

    // Verify onMessage was called (streams to chat)
    // chatMessages[0] is the "Job started" message from sendToNewSprite
    assert.strictEqual(chatMessages.length, 4);
    assert.ok(chatMessages[0].includes('started'));
    assert.strictEqual(chatMessages[1], 'Cloning repo...');

    // 6. Simulate Sprite posting artifacts
    const artRes = await post(port, '/webhooks/artifacts', {
      jobId,
      artifacts: [
        { name: 'Test Report', url: 'https://example.com/report.html', type: 'report' }
      ]
    }, token);
    assert.strictEqual(artRes.status, 200);
    assert.strictEqual(job.artifacts.length, 1);

    // 7. Simulate Sprite posting completed status
    const statusRes = await post(port, '/webhooks/status', {
      jobId, status: 'completed', exitCode: 0
    }, token);
    assert.strictEqual(statusRes.status, 200);

    // 8. The sendToInstance Promise should now resolve
    const result = await sendPromise;
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.jobId, jobId);
    assert.ok(result.artifacts);
    assert.strictEqual(result.artifacts.length, 1);
    assert.strictEqual(result.artifacts[0].name, 'Test Report');
  });

  it('failed job lifecycle: spawn → logs → failed status → resolve with error', async () => {
    await manager.startInstance('fail-test', 'owner/repo', 'C123');

    const sendPromise = manager.sendToInstance('fail-test', 'run broken thing', {
      onMessage: async () => {}
    });

    await new Promise(r => setTimeout(r, 50));

    const jobs = manager.listJobs();
    const jobId = jobs[jobs.length - 1].jobId;
    const job = manager.getJob(jobId);
    const token = job.jobToken;

    // Sprite sends some output then fails
    await post(port, '/webhooks/logs', { jobId, text: 'Starting...' }, token);
    await post(port, '/webhooks/status', {
      jobId, status: 'failed', exitCode: 1, error: 'Tests failed: 3 failures'
    }, token);

    const result = await sendPromise;
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.jobId, jobId);
  });

  it('should reject webhook calls with wrong token', async () => {
    await manager.startInstance('auth-test', 'owner/repo', 'C123');

    const sendPromise = manager.sendToInstance('auth-test', 'task', {
      onMessage: async () => {}
    });

    await new Promise(r => setTimeout(r, 50));

    const jobs = manager.listJobs();
    const jobId = jobs[jobs.length - 1].jobId;
    const job = manager.getJob(jobId);

    // Try with wrong token
    const res = await post(port, '/webhooks/logs', { jobId, text: 'hack' }, 'wrong-token');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(job.logs.length, 0); // nothing should be logged

    // Clean up — complete the job properly so the Promise resolves
    job.complete(0);
    if (job.onComplete) await job.onComplete(job);
    await sendPromise;
  });

  it('webhook health check works with active jobs', async () => {
    await manager.startInstance('health-test', 'owner/repo', 'C123');

    // Start a job (don't await — we just want it in the map)
    const sendPromise = manager.sendToInstance('health-test', 'task', {
      onMessage: async () => {}
    });

    await new Promise(r => setTimeout(r, 50));

    // Check health
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (r) => {
        let data = '';
        r.on('data', chunk => { data += chunk; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
      }).on('error', reject);
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'healthy');
    assert.ok(res.body.jobs >= 1);

    // Clean up
    const jobs = manager.listJobs();
    const job = manager.getJob(jobs[jobs.length - 1].jobId);
    job.complete(0);
    if (job.onComplete) await job.onComplete(job);
    await sendPromise;
  });

  it('multiple concurrent jobs should not interfere', async () => {
    await manager.startInstance('job-a', 'owner/repo-a', 'C1');
    await manager.startInstance('job-b', 'owner/repo-b', 'C2');

    const messagesA = [];
    const messagesB = [];

    const promiseA = manager.sendToInstance('job-a', 'task A', {
      onMessage: async (text) => { messagesA.push(text); }
    });

    const promiseB = manager.sendToInstance('job-b', 'task B', {
      onMessage: async (text) => { messagesB.push(text); }
    });

    await new Promise(r => setTimeout(r, 50));

    const allJobs = manager.listJobs();
    assert.strictEqual(allJobs.length, 2);

    // Get both jobs
    const jobA = manager.getJob(allJobs[0].jobId);
    const jobB = manager.getJob(allJobs[1].jobId);

    // Send logs to each with their own tokens
    await post(port, '/webhooks/logs', { jobId: jobA.jobId, text: 'output A' }, jobA.jobToken);
    await post(port, '/webhooks/logs', { jobId: jobB.jobId, text: 'output B' }, jobB.jobToken);

    // Verify isolation
    assert.strictEqual(jobA.logs.length, 1);
    assert.strictEqual(jobA.logs[0].message, 'output A');
    assert.strictEqual(jobB.logs.length, 1);
    assert.strictEqual(jobB.logs[0].message, 'output B');
    // messagesA[0] is the "Job started" message, messagesA[1] is the webhook log
    assert.strictEqual(messagesA.length, 2);
    assert.strictEqual(messagesA[1], 'output A');
    assert.strictEqual(messagesB.length, 2);
    assert.strictEqual(messagesB[1], 'output B');

    // Cross-token should fail
    const crossRes = await post(port, '/webhooks/logs', { jobId: jobA.jobId, text: 'hack' }, jobB.jobToken);
    assert.strictEqual(crossRes.status, 401);

    // Complete both
    await post(port, '/webhooks/status', { jobId: jobA.jobId, status: 'completed', exitCode: 0 }, jobA.jobToken);
    await post(port, '/webhooks/status', { jobId: jobB.jobId, status: 'completed', exitCode: 0 }, jobB.jobToken);

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    assert.strictEqual(resultA.success, true);
    assert.strictEqual(resultB.success, true);
  });
});

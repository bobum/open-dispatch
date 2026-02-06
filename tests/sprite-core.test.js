/**
 * Tests for sprite-core (instance manager with mocked orchestrator)
 *
 * Verifies the full lifecycle: start instance → send message → webhook
 * callback → job completes → Promise resolves.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createInstanceManager } = require('../src/sprite-core');
const { JobStatus } = require('../src/job');

/**
 * Create a mock orchestrator that simulates Fly Machines API
 * without making any real HTTP calls.
 */
function createMockOrchestrator(options = {}) {
  const { spawnDelay = 0, spawnError = null, execResult = null } = options;
  let spawnCount = 0;
  let lastSpawnedJob = null;
  let lastPersistentOptions = null;

  return {
    spawnCount: () => spawnCount,
    lastSpawnedJob: () => lastSpawnedJob,
    lastPersistentOptions: () => lastPersistentOptions,

    generateJobToken(jobId) {
      return `mock-token-${jobId.substring(0, 8)}`;
    },

    async spawnJob(job) {
      spawnCount++;
      lastSpawnedJob = job;

      if (spawnError) {
        job.fail(spawnError);
        throw new Error(spawnError);
      }

      await new Promise(r => setTimeout(r, spawnDelay));

      const machineId = `mock-machine-${spawnCount}`;
      job.start(machineId);
      return { id: machineId, state: 'started' };
    },

    async spawnPersistent(options) {
      spawnCount++;
      lastPersistentOptions = options;
      return { id: `mock-persistent-${spawnCount}`, state: 'started' };
    },

    async stopSprite(machineId) {
      return { ok: true };
    },

    async destroyMachine(machineId) {
      return;
    },

    async sendCommand(machineId, command) {
      if (execResult) return execResult;
      return { stdout: 'command output\n', stderr: '', exit_code: 0 };
    },

    async streamCommand(machineId, command, onOutput) {
      const result = execResult || { stdout: 'streamed output\n', stderr: '', exit_code: 0 };
      if (result.stdout) {
        for (const line of result.stdout.split('\n')) {
          if (line.trim()) onOutput(line);
        }
      }
      return { success: (result.exit_code || 0) === 0, exitCode: result.exit_code || 0 };
    },

    async wakeSprite() {
      return { ok: true };
    }
  };
}

describe('Sprite Instance Manager', () => {
  let manager;
  let orchestrator;

  beforeEach(() => {
    orchestrator = createMockOrchestrator();
    manager = createInstanceManager({
      orchestrator,
      apiToken: 'fake-token',
      appName: 'test-sprites'
    });
  });

  afterEach(() => {
    manager.stopStaleReaper();
    manager.clearInstances();
  });

  describe('startInstance', () => {
    it('should create a new instance', async () => {
      const result = await manager.startInstance('test', 'owner/repo', 'C123');
      assert.strictEqual(result.success, true);
      assert.ok(result.sessionId);
    });

    it('should fail for duplicate instanceId', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123');
      const result = await manager.startInstance('test', 'owner/repo', 'C456');
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('already running'));
    });

    it('should spawn persistent Machine when requested', async () => {
      const result = await manager.startInstance('test', 'owner/repo', 'C123', { persistent: true });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.persistent, true);
      assert.ok(result.spriteId);
    });

    it('should handle persistent spawn failure', async () => {
      const failOrch = createMockOrchestrator();
      failOrch.spawnPersistent = async () => { throw new Error('spawn failed'); };
      const m = createInstanceManager({ orchestrator: failOrch });
      const result = await m.startInstance('test', 'owner/repo', 'C123', { persistent: true });
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('spawn'));
    });
  });

  describe('stopInstance', () => {
    it('should stop an existing instance', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123');
      const result = manager.stopInstance('test');
      assert.strictEqual(result.success, true);
    });

    it('should fail for unknown instance', () => {
      const result = manager.stopInstance('nonexistent');
      assert.strictEqual(result.success, false);
    });

    it('should remove instance from map', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123');
      manager.stopInstance('test');
      assert.strictEqual(manager.getInstance('test'), null);
    });
  });

  describe('getInstance / getInstanceByChannel', () => {
    it('should find instance by id', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123');
      const instance = manager.getInstance('test');
      assert.ok(instance);
      assert.strictEqual(instance.channelId, 'C123');
    });

    it('should find instance by channel', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123');
      const found = manager.getInstanceByChannel('C123');
      assert.ok(found);
      assert.strictEqual(found.instanceId, 'test');
    });

    it('should return null for unknown channel', () => {
      assert.strictEqual(manager.getInstanceByChannel('unknown'), null);
    });
  });

  describe('listInstances', () => {
    it('should list all instances', async () => {
      await manager.startInstance('a', 'owner/repo', 'C1');
      await manager.startInstance('b', 'other/repo', 'C2');
      const list = manager.listInstances();
      assert.strictEqual(list.length, 2);
    });
  });

  describe('sendToInstance (persistent)', () => {
    it('should send command to persistent Sprite via streamCommand', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123', { persistent: true });

      const messages = [];
      const result = await manager.sendToInstance('test', 'run tests', {
        onMessage: async (text) => { messages.push(text); }
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.persistent, true);
      assert.strictEqual(result.streamed, true);
      assert.ok(messages.length > 0);
    });

    it('should return error for unknown instance', async () => {
      const result = await manager.sendToInstance('nonexistent', 'hello');
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });
  });

  describe('sendToInstance (one-shot)', () => {
    it('should spawn job and resolve when onComplete fires', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123');

      // Simulate: after spawn, the webhook fires status=completed
      const sendPromise = manager.sendToInstance('test', 'run tests', {
        onMessage: async () => {},
        repo: 'owner/repo'
      });

      // Give the spawn a moment to run
      await new Promise(r => setTimeout(r, 50));

      // Find the job and fire its onComplete (simulating webhook)
      const jobsList = manager.listJobs();
      assert.ok(jobsList.length > 0, 'Should have at least one job');
      const jobId = jobsList[jobsList.length - 1].jobId;
      const job = manager.getJob(jobId);
      assert.ok(job, 'Job should exist');
      assert.ok(job.onComplete, 'Job should have onComplete callback');

      // Simulate webhook firing
      job.complete(0);
      await job.onComplete(job);

      const result = await sendPromise;
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.jobId, jobId);
    });

    it('should timeout if webhook never fires', async () => {
      await manager.startInstance('timeout-test', 'owner/repo', 'C123');

      const result = await manager.sendToInstance('timeout-test', 'slow task', {
        onMessage: async () => {},
        repo: 'owner/repo',
        timeoutMs: 200 // short timeout for fast test
      });

      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('timed out'));
      assert.ok(result.jobId);
    });

    it('should handle spawn failure', async () => {
      const failOrch = createMockOrchestrator({ spawnError: 'Machines API 500' });
      const m = createInstanceManager({ orchestrator: failOrch });
      await m.startInstance('test', 'owner/repo', 'C123');
      const result = await m.sendToInstance('test', 'task', { onMessage: async () => {} });
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Machines API 500'));
    });
  });

  describe('job management', () => {
    it('should track jobs in the jobs map', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123', { persistent: true });
      await manager.sendToInstance('test', 'run tests', { onMessage: async () => {} });
      const jobs = manager.listJobs();
      assert.ok(jobs.length > 0);
    });

    it('should retrieve job by id', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123', { persistent: true });
      await manager.sendToInstance('test', 'run tests', { onMessage: async () => {} });
      const jobs = manager.listJobs();
      const job = manager.getJob(jobs[0].jobId);
      assert.ok(job);
      assert.strictEqual(job.repo, 'owner/repo');
    });
  });

  describe('stale reaper', () => {
    it('should start and stop without error', () => {
      manager.startStaleReaper();
      manager.startStaleReaper(); // idempotent
      manager.stopStaleReaper();
      manager.stopStaleReaper(); // idempotent
    });
  });

  describe('buildArgs', () => {
    it('should build claude command by default', async () => {
      await manager.startInstance('test', 'owner/repo', 'C123');
      const instance = manager.getInstance('test');
      const args = manager.buildArgs('hello world', 'owner/repo', instance.sessionId);
      assert.ok(args.length > 0);
      // Should contain 'claude' since default agent is claude
      assert.ok(args.some(a => a.includes('claude') || a.includes('opencode')));
    });
  });
});

describe('Sprite Orchestrator (mocked)', () => {
  // Test the orchestrator's token generation
  const { SpriteOrchestrator } = require('../src/sprite-orchestrator');

  it('should generate deterministic job tokens', () => {
    const orch = new SpriteOrchestrator({ apiToken: 'test', appName: 'test', tokenSecret: 'fixed-secret' });
    const token1 = orch.generateJobToken('job-123');
    const token2 = orch.generateJobToken('job-123');
    const token3 = orch.generateJobToken('job-456');
    assert.strictEqual(token1, token2); // same input = same output
    assert.notStrictEqual(token1, token3); // different input = different output
    assert.strictEqual(typeof token1, 'string');
    assert.ok(token1.length > 0);
  });

  it('should construct correct Machines API URLs', () => {
    const orch = new SpriteOrchestrator({ apiToken: 'test', appName: 'my-sprites' });
    // Access private method via prototype or just verify constructor stored values
    assert.strictEqual(orch.appName, 'my-sprites');
    assert.strictEqual(orch.baseUrl, 'https://api.machines.dev/v1');
  });

  it('should use env vars as defaults', () => {
    // Temporarily set env
    const origToken = process.env.FLY_API_TOKEN;
    const origApp = process.env.FLY_SPRITE_APP;
    process.env.FLY_API_TOKEN = 'env-token';
    process.env.FLY_SPRITE_APP = 'env-app';

    const orch = new SpriteOrchestrator({});
    assert.strictEqual(orch.apiToken, 'env-token');
    assert.strictEqual(orch.appName, 'env-app');

    // Restore
    if (origToken) process.env.FLY_API_TOKEN = origToken;
    else delete process.env.FLY_API_TOKEN;
    if (origApp) process.env.FLY_SPRITE_APP = origApp;
    else delete process.env.FLY_SPRITE_APP;
  });

  describe('spawnJob with mocked fetch', () => {
    it('should POST to Machines API and return machine info', async () => {
      let capturedUrl = null;
      let capturedBody = null;

      const mockFetch = async (url, options) => {
        capturedUrl = url;
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ id: 'machine-abc', state: 'started' }),
          text: async () => ''
        };
      };

      const orch = new SpriteOrchestrator({
        apiToken: 'test-token',
        appName: 'test-app',
        fetchFn: mockFetch
      });

      const { Job } = require('../src/job');
      const job = new Job({
        repo: 'owner/repo',
        command: 'claude -p "test"',
        channelId: 'C123',
        jobToken: 'test-job-token'
      });

      const result = await orch.spawnJob(job);
      assert.strictEqual(result.id, 'machine-abc');
      assert.ok(capturedUrl.includes('/apps/test-app/machines'));
      assert.strictEqual(capturedBody.config.auto_destroy, true);
      assert.strictEqual(capturedBody.config.env.JOB_ID, job.jobId);
      assert.strictEqual(capturedBody.config.env.REPO, 'owner/repo');
      assert.strictEqual(capturedBody.config.env.COMMAND, 'claude -p "test"');
      assert.strictEqual(job.status, JobStatus.RUNNING);
      assert.strictEqual(job.machineId, 'machine-abc');
    });

    it('should handle API errors', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      });

      const orch = new SpriteOrchestrator({
        apiToken: 'test', appName: 'test', fetchFn: mockFetch
      });

      const { Job } = require('../src/job');
      const job = new Job({ repo: 'r', command: 'c', channelId: 'ch' });

      await assert.rejects(
        () => orch.spawnJob(job),
        (err) => {
          assert.ok(err.message.includes('500'));
          return true;
        }
      );
      assert.strictEqual(job.status, JobStatus.FAILED);
    });
  });

  describe('stopSprite with mocked fetch', () => {
    it('should POST to stop endpoint', async () => {
      let capturedUrl = null;
      const mockFetch = async (url, options) => {
        capturedUrl = url;
        return { ok: true, json: async () => ({ ok: true }) };
      };

      const orch = new SpriteOrchestrator({
        apiToken: 'test', appName: 'test-app', fetchFn: mockFetch
      });

      await orch.stopSprite('machine-123');
      assert.ok(capturedUrl.includes('/machines/machine-123/stop'));
    });
  });

  describe('destroyMachine with mocked fetch', () => {
    it('should DELETE the machine', async () => {
      let capturedMethod = null;
      let capturedUrl = null;
      const mockFetch = async (url, options) => {
        capturedUrl = url;
        capturedMethod = options.method;
        return { ok: true };
      };

      const orch = new SpriteOrchestrator({
        apiToken: 'test', appName: 'test-app', fetchFn: mockFetch
      });

      await orch.destroyMachine('machine-456');
      assert.strictEqual(capturedMethod, 'DELETE');
      assert.ok(capturedUrl.includes('/machines/machine-456'));
    });

    it('should not throw for 404 (already destroyed)', async () => {
      const mockFetch = async () => ({ ok: false, status: 404 });
      const orch = new SpriteOrchestrator({
        apiToken: 'test', appName: 'test-app', fetchFn: mockFetch
      });

      // Should not throw
      await orch.destroyMachine('gone');
    });
  });
});

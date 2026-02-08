/**
 * Tests for the Job class and lifecycle tracking
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Job, JobStatus } = require('../src/job');

describe('Job', () => {
  let job;

  beforeEach(() => {
    job = new Job({
      command: 'claude -p "run tests"',
      channelId: 'C123',
      projectDir: 'owner/repo',
      jobToken: 'test-token-abc'
    });
  });

  describe('constructor', () => {
    it('should generate a jobId if not provided', () => {
      assert.ok(job.jobId);
      assert.strictEqual(typeof job.jobId, 'string');
      assert.ok(job.jobId.length > 0);
    });

    it('should use provided jobId', () => {
      const custom = new Job({ jobId: 'custom-id', command: 'c', channelId: 'ch' });
      assert.strictEqual(custom.jobId, 'custom-id');
    });

    it('should set initial status to queued', () => {
      assert.strictEqual(job.status, JobStatus.QUEUED);
    });

    it('should store all provided fields', () => {
      assert.strictEqual(job.command, 'claude -p "run tests"');
      assert.strictEqual(job.channelId, 'C123');
      assert.strictEqual(job.jobToken, 'test-token-abc');
    });

    it('should default timeoutMs to 600000', () => {
      assert.strictEqual(job.timeoutMs, 600000);
    });

    it('should accept custom timeoutMs', () => {
      const j = new Job({ command: 'c', channelId: 'ch', timeoutMs: 30000 });
      assert.strictEqual(j.timeoutMs, 30000);
    });

    it('should initialize empty logs and artifacts', () => {
      assert.deepStrictEqual(job.logs, []);
      assert.deepStrictEqual(job.artifacts, []);
    });

    it('should store callback references', () => {
      const onMsg = async () => {};
      const onDone = async () => {};
      const j = new Job({ command: 'c', channelId: 'ch', onMessage: onMsg, onComplete: onDone });
      assert.strictEqual(j.onMessage, onMsg);
      assert.strictEqual(j.onComplete, onDone);
    });
  });

  describe('start', () => {
    it('should set status to running', () => {
      job.start('machine-123');
      assert.strictEqual(job.status, JobStatus.RUNNING);
    });

    it('should set machineId and spriteId', () => {
      job.start('machine-123');
      assert.strictEqual(job.machineId, 'machine-123');
      assert.strictEqual(job.spriteId, 'machine-123');
    });

    it('should set startedAt timestamp', () => {
      job.start('machine-123');
      assert.ok(job.startedAt instanceof Date);
    });

    it('should update lastActivityAt', () => {
      const before = job.lastActivityAt;
      job.start('machine-123');
      assert.ok(job.lastActivityAt >= before);
    });
  });

  describe('complete', () => {
    it('should set status to completed', () => {
      job.start('m1');
      job.complete(0);
      assert.strictEqual(job.status, JobStatus.COMPLETED);
    });

    it('should set exitCode', () => {
      job.start('m1');
      job.complete(42);
      assert.strictEqual(job.exitCode, 42);
    });

    it('should default exitCode to 0', () => {
      job.start('m1');
      job.complete();
      assert.strictEqual(job.exitCode, 0);
    });

    it('should set completedAt timestamp', () => {
      job.start('m1');
      job.complete(0);
      assert.ok(job.completedAt instanceof Date);
    });
  });

  describe('fail', () => {
    it('should set status to failed', () => {
      job.start('m1');
      job.fail('something broke');
      assert.strictEqual(job.status, JobStatus.FAILED);
    });

    it('should store error message', () => {
      job.start('m1');
      job.fail('something broke');
      assert.strictEqual(job.error, 'something broke');
    });

    it('should set exitCode', () => {
      job.start('m1');
      job.fail('err', 127);
      assert.strictEqual(job.exitCode, 127);
    });

    it('should default exitCode to 1', () => {
      job.start('m1');
      job.fail('err');
      assert.strictEqual(job.exitCode, 1);
    });
  });

  describe('addLog', () => {
    it('should append log entries', () => {
      job.addLog('line 1');
      job.addLog('line 2');
      assert.strictEqual(job.logs.length, 2);
      assert.strictEqual(job.logs[0].message, 'line 1');
      assert.strictEqual(job.logs[1].message, 'line 2');
    });

    it('should set default level to info', () => {
      job.addLog('test');
      assert.strictEqual(job.logs[0].level, 'info');
    });

    it('should accept custom level', () => {
      job.addLog('error!', 'error');
      assert.strictEqual(job.logs[0].level, 'error');
    });

    it('should include timestamp', () => {
      job.addLog('test');
      assert.ok(job.logs[0].timestamp instanceof Date);
    });

    it('should update lastActivityAt', () => {
      const before = job.lastActivityAt;
      job.addLog('test');
      assert.ok(job.lastActivityAt >= before);
    });
  });

  describe('addArtifact', () => {
    it('should add artifact with name and url', () => {
      job.addArtifact({ name: 'PR', url: 'https://github.com/owner/repo/pull/1' });
      assert.strictEqual(job.artifacts.length, 1);
      assert.strictEqual(job.artifacts[0].name, 'PR');
      assert.strictEqual(job.artifacts[0].url, 'https://github.com/owner/repo/pull/1');
    });

    it('should default type to file', () => {
      job.addArtifact({ name: 'test', url: 'http://example.com' });
      assert.strictEqual(job.artifacts[0].type, 'file');
    });

    it('should accept custom type', () => {
      job.addArtifact({ name: 'test', url: 'http://example.com', type: 'screenshot' });
      assert.strictEqual(job.artifacts[0].type, 'screenshot');
    });

    it('should include addedAt timestamp', () => {
      job.addArtifact({ name: 'test', url: 'http://example.com' });
      assert.ok(job.artifacts[0].addedAt instanceof Date);
    });
  });

  describe('isTimedOut', () => {
    it('should return false for non-running jobs', () => {
      assert.strictEqual(job.isTimedOut(), false); // queued
      job.start('m1');
      job.complete(0);
      assert.strictEqual(job.isTimedOut(), false); // completed
    });

    it('should return false for recent activity', () => {
      job.start('m1');
      assert.strictEqual(job.isTimedOut(), false);
    });

    it('should return true when activity exceeds timeout', () => {
      job = new Job({ command: 'c', channelId: 'ch', timeoutMs: 1 });
      job.start('m1');
      // Force lastActivityAt into the past
      job.lastActivityAt = new Date(Date.now() - 100);
      assert.strictEqual(job.isTimedOut(), true);
    });

    it('should reset timeout on addLog', () => {
      job = new Job({ command: 'c', channelId: 'ch', timeoutMs: 50 });
      job.start('m1');
      job.lastActivityAt = new Date(Date.now() - 100);
      assert.strictEqual(job.isTimedOut(), true);
      job.addLog('still alive');
      assert.strictEqual(job.isTimedOut(), false);
    });
  });

  describe('getDuration', () => {
    it('should return null if not started', () => {
      assert.strictEqual(job.getDuration(), null);
    });

    it('should return duration for completed job', () => {
      job.start('m1');
      job.complete(0);
      const duration = job.getDuration();
      assert.ok(typeof duration === 'number');
      assert.ok(duration >= 0);
    });
  });

  describe('toSummary', () => {
    it('should return summary fields', () => {
      job.start('m1');
      job.addLog('test');
      job.addArtifact({ name: 'PR', url: 'http://example.com' });
      const summary = job.toSummary();
      assert.strictEqual(summary.jobId, job.jobId);
      assert.strictEqual(summary.status, JobStatus.RUNNING);
      assert.strictEqual(summary.artifactCount, 1);
      assert.strictEqual(summary.logCount, 1);
    });
  });

  describe('toJSON / fromJSON', () => {
    it('should serialize and deserialize correctly', () => {
      job.start('machine-abc');
      job.addLog('log entry');
      job.addArtifact({ name: 'PR', url: 'http://example.com' });
      job.complete(0);

      const json = job.toJSON();
      const restored = Job.fromJSON(json);

      assert.strictEqual(restored.jobId, job.jobId);
      assert.strictEqual(restored.status, JobStatus.COMPLETED);
      assert.strictEqual(restored.exitCode, 0);
      assert.strictEqual(restored.logs.length, 1);
      assert.strictEqual(restored.artifacts.length, 1);
      assert.strictEqual(restored.machineId, 'machine-abc');
    });

    it('should not serialize callbacks or token', () => {
      job.onMessage = async () => {};
      job.onComplete = async () => {};
      const json = job.toJSON();
      assert.strictEqual(json.onMessage, undefined);
      assert.strictEqual(json.onComplete, undefined);
      assert.strictEqual(json.jobToken, undefined);
    });

    it('should restore dates as Date objects', () => {
      job.start('m1');
      job.complete(0);
      const restored = Job.fromJSON(job.toJSON());
      assert.ok(restored.createdAt instanceof Date);
      assert.ok(restored.startedAt instanceof Date);
      assert.ok(restored.completedAt instanceof Date);
    });
  });
});

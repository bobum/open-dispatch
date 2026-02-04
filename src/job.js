/**
 * Job Module
 *
 * Represents a job submitted to run in a Sprite (ephemeral micro-VM).
 * Tracks metadata, status, logs, and artifacts for each job.
 */

const { randomUUID } = require('crypto');

/**
 * Job status enumeration
 */
const JobStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

/**
 * Job class for tracking Sprite-based agent executions
 */
class Job {
  /**
   * Create a new Job
   * @param {Object} params - Job parameters
   * @param {string} [params.jobId] - Unique job identifier (auto-generated if not provided)
   * @param {string} params.repo - GitHub repository URL
   * @param {string} params.branch - Branch name to checkout
   * @param {string} params.command - Command to execute in the Sprite
   * @param {string} params.slackChannel - Slack channel ID for results
   * @param {string} [params.projectDir] - Project directory path (optional, for local context)
   * @param {string} [params.userId] - User who initiated the job
   * @param {string} [params.image] - Docker image to use for this job (overrides default)
   */
  constructor({ jobId, repo, branch, command, slackChannel, projectDir, userId, image }) {
    this.jobId = jobId || randomUUID();
    this.repo = repo;
    this.branch = branch || 'main';
    this.command = command;
    this.slackChannel = slackChannel;
    this.projectDir = projectDir || null;
    this.userId = userId || null;
    this.image = image || null;
    this.status = JobStatus.QUEUED;
    this.logs = [];
    this.artifacts = [];
    this.spriteId = null;
    this.createdAt = new Date();
    this.startedAt = null;
    this.completedAt = null;
    this.error = null;
    this.exitCode = null;
  }

  /**
   * Mark job as running
   * @param {string} spriteId - The Sprite instance ID
   */
  start(spriteId) {
    this.status = JobStatus.RUNNING;
    this.spriteId = spriteId;
    this.startedAt = new Date();
  }

  /**
   * Mark job as completed
   * @param {number} [exitCode] - Process exit code
   */
  complete(exitCode = 0) {
    this.status = JobStatus.COMPLETED;
    this.completedAt = new Date();
    this.exitCode = exitCode;
  }

  /**
   * Mark job as failed
   * @param {string} error - Error message
   * @param {number} [exitCode] - Process exit code
   */
  fail(error, exitCode = 1) {
    this.status = JobStatus.FAILED;
    this.completedAt = new Date();
    this.error = error;
    this.exitCode = exitCode;
  }

  /**
   * Append a log entry
   * @param {string} message - Log message
   * @param {string} [level] - Log level (info, warn, error)
   */
  addLog(message, level = 'info') {
    this.logs.push({
      timestamp: new Date(),
      level,
      message
    });
  }

  /**
   * Add an artifact URL
   * @param {Object} artifact - Artifact info
   * @param {string} artifact.name - Artifact name
   * @param {string} artifact.url - Artifact URL
   * @param {string} [artifact.type] - Artifact type (screenshot, video, log, etc.)
   */
  addArtifact({ name, url, type = 'file' }) {
    this.artifacts.push({
      name,
      url,
      type,
      addedAt: new Date()
    });
  }

  /**
   * Get job duration in milliseconds
   * @returns {number|null} Duration or null if not started
   */
  getDuration() {
    if (!this.startedAt) return null;
    const endTime = this.completedAt || new Date();
    return endTime - this.startedAt;
  }

  /**
   * Get a summary of the job for display
   * @returns {Object} Job summary
   */
  toSummary() {
    return {
      jobId: this.jobId,
      repo: this.repo,
      branch: this.branch,
      status: this.status,
      duration: this.getDuration(),
      artifactCount: this.artifacts.length,
      logCount: this.logs.length,
      error: this.error
    };
  }

  /**
   * Serialize job to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      jobId: this.jobId,
      repo: this.repo,
      branch: this.branch,
      command: this.command,
      slackChannel: this.slackChannel,
      projectDir: this.projectDir,
      userId: this.userId,
      image: this.image,
      status: this.status,
      logs: this.logs,
      artifacts: this.artifacts,
      spriteId: this.spriteId,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error,
      exitCode: this.exitCode
    };
  }

  /**
   * Create a Job from JSON
   * @param {Object} json - JSON representation
   * @returns {Job} Job instance
   */
  static fromJSON(json) {
    const job = new Job({
      jobId: json.jobId,
      repo: json.repo,
      branch: json.branch,
      command: json.command,
      slackChannel: json.slackChannel,
      projectDir: json.projectDir,
      userId: json.userId,
      image: json.image
    });
    job.status = json.status;
    job.logs = json.logs || [];
    job.artifacts = json.artifacts || [];
    job.spriteId = json.spriteId;
    job.createdAt = new Date(json.createdAt);
    job.startedAt = json.startedAt ? new Date(json.startedAt) : null;
    job.completedAt = json.completedAt ? new Date(json.completedAt) : null;
    job.error = json.error;
    job.exitCode = json.exitCode;
    return job;
  }
}

module.exports = {
  Job,
  JobStatus
};

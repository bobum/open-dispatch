/**
 * Sprite Orchestrator Module
 *
 * Handles spawning and managing ephemeral micro-VMs (Sprites) for running
 * AI coding agents in isolated environments.
 *
 * Sprites are event-driven, usage-billed VMs that auto-sleep when idle.
 * They provide clean, isolated environments per job.
 */

const EventEmitter = require('events');

/**
 * SpriteOrchestrator manages the lifecycle of Sprite VMs
 */
class SpriteOrchestrator extends EventEmitter {
  /**
   * Create a SpriteOrchestrator
   * @param {Object} options - Configuration options
   * @param {string} options.apiToken - Sprite API token (SPRITE_API_TOKEN)
   * @param {string} [options.baseUrl] - Sprite API base URL
   * @param {string} [options.baseImage] - Base Docker image for Sprites
   * @param {string} [options.region] - Preferred region for Sprites
   * @param {Function} [options.fetchFn] - Optional fetch function for testing
   */
  constructor(options = {}) {
    super();
    this.apiToken = options.apiToken || process.env.SPRITE_API_TOKEN;
    this.baseUrl = options.baseUrl || process.env.SPRITE_API_URL || 'https://api.sprites.dev/v1';
    this.baseImage = options.baseImage || process.env.SPRITE_BASE_IMAGE || 'open-dispatch/agent:latest';
    this.region = options.region || process.env.SPRITE_REGION || 'iad';
    this.fetchFn = options.fetchFn || fetch;

    if (!this.apiToken) {
      console.warn('[SpriteOrchestrator] No API token provided. Set SPRITE_API_TOKEN environment variable.');
    }
  }

  /**
   * Spawn a new Sprite for a job
   * @param {Job} job - The job to run
   * @param {Object} [options] - Spawn options
   * @param {number} [options.timeoutMs] - Max runtime in milliseconds
   * @param {Object} [options.env] - Additional environment variables
   * @returns {Promise<Object>} Sprite info with id, status
   */
  async spawnJob(job, options = {}) {
    const { timeoutMs = 600000, env = {} } = options;

    // Use job-specific image if provided, otherwise fall back to default
    const image = job.image || this.baseImage;

    const command = this._buildCommand(job);
    const spriteEnv = {
      JOB_ID: job.jobId,
      REPO: job.repo,
      BRANCH: job.branch,
      SLACK_CHANNEL: job.slackChannel,
      COMMAND: job.command,
      ...env
    };

    try {
      const response = await this.fetchFn(`${this.baseUrl}/sprites`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          image: image,
          command: command,
          env: spriteEnv,
          region: this.region,
          timeout_ms: timeoutMs
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Sprite API error: ${response.status} - ${errorText}`);
      }

      const spriteInfo = await response.json();

      job.start(spriteInfo.id);
      this.emit('sprite:started', { job, spriteInfo });

      return spriteInfo;
    } catch (error) {
      job.fail(error.message);
      this.emit('sprite:error', { job, error });
      throw error;
    }
  }

  /**
   * Build the command to run inside the Sprite
   * @param {Job} job - The job
   * @returns {string[]} Command array
   */
  _buildCommand(job) {
    // Command is an array for exec-style spawning
    // The entrypoint script will handle git clone, checkout, and running the agent
    return [
      '/bin/sh', '-c',
      `
        set -e
        echo "[Sprite] Starting job ${job.jobId}"

        # Clone repository
        git clone --depth 1 --branch ${this._escapeShell(job.branch)} ${this._escapeShell(job.repo)} /workspace || {
          git clone ${this._escapeShell(job.repo)} /workspace
          cd /workspace
          git checkout ${this._escapeShell(job.branch)} || git checkout -b ${this._escapeShell(job.branch)}
        }

        cd /workspace
        echo "[Sprite] Repository cloned, running command"

        # Run the agent command
        ${job.command}

        echo "[Sprite] Command completed"
      `.trim()
    ];
  }

  /**
   * Escape a string for shell use
   * @param {string} str - String to escape
   * @returns {string} Escaped string
   */
  _escapeShell(str) {
    if (!str) return '""';
    return `'${str.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Get the status of a Sprite
   * @param {string} spriteId - Sprite ID
   * @returns {Promise<Object>} Sprite status
   */
  async getSpriteStatus(spriteId) {
    const response = await this.fetchFn(`${this.baseUrl}/sprites/${spriteId}`, {
      headers: {
        'Authorization': `Bearer ${this.apiToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get sprite status: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Stream logs from a Sprite
   * @param {string} spriteId - Sprite ID
   * @param {Function} onLog - Callback for each log line: (log: string) => void
   * @returns {Promise<void>}
   */
  async streamLogs(spriteId, onLog) {
    const response = await this.fetchFn(`${this.baseUrl}/sprites/${spriteId}/logs`, {
      headers: {
        'Authorization': `Bearer ${this.apiToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to stream logs: ${response.status}`);
    }

    // Handle streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            onLog(line);
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        onLog(buffer);
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Wait for a Sprite to complete
   * @param {string} spriteId - Sprite ID
   * @param {Object} [options] - Options
   * @param {number} [options.pollIntervalMs] - Poll interval in ms
   * @param {number} [options.timeoutMs] - Max wait time in ms
   * @returns {Promise<Object>} Final sprite status
   */
  async waitForCompletion(spriteId, options = {}) {
    const { pollIntervalMs = 5000, timeoutMs = 600000 } = options;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getSpriteStatus(spriteId);

      if (status.state === 'completed' || status.state === 'failed' || status.state === 'stopped') {
        return status;
      }

      await this._sleep(pollIntervalMs);
    }

    throw new Error(`Sprite ${spriteId} timed out after ${timeoutMs}ms`);
  }

  /**
   * Stop a running Sprite
   * @param {string} spriteId - Sprite ID
   * @returns {Promise<Object>} Stop result
   */
  async stopSprite(spriteId) {
    const response = await this.fetchFn(`${this.baseUrl}/sprites/${spriteId}/stop`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to stop sprite: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get artifacts from a completed Sprite
   * @param {string} spriteId - Sprite ID
   * @returns {Promise<Object[]>} List of artifacts
   */
  async getArtifacts(spriteId) {
    const response = await this.fetchFn(`${this.baseUrl}/sprites/${spriteId}/artifacts`, {
      headers: {
        'Authorization': `Bearer ${this.apiToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get artifacts: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Upload artifacts to persistent storage
   * @param {string} spriteId - Sprite ID
   * @param {string} artifactPath - Path pattern for artifacts (e.g., "artifacts/*")
   * @returns {Promise<Object[]>} Uploaded artifact URLs
   */
  async uploadArtifacts(spriteId, artifactPath = 'artifacts/*') {
    const response = await this.fetchFn(`${this.baseUrl}/sprites/${spriteId}/artifacts/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: artifactPath })
    });

    if (!response.ok) {
      throw new Error(`Failed to upload artifacts: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Sleep helper
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { SpriteOrchestrator };

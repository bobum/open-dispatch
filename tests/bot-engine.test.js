/**
 * Tests for bot-engine unified command parsing, message batching, routing,
 * image alias resolution, and entry-point safety checks.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createBotEngine, _test } = require('../src/bot-engine');

// ============================================
// Mock Chat Provider (for unified command tests)
// ============================================

function createMockChatProvider() {
  const sent = [];
  const cards = [];
  const commandHandlers = [];
  const messageHandlers = [];
  const errorHandlers = [];

  return {
    name: 'mock',
    supportsCards: false,
    sent,
    cards,
    commandHandlers,
    messageHandlers,

    async initialize() {},
    async start() {},
    async stop() {},
    async sendMessage(channelId, text) {
      sent.push({ channelId, text });
      return { messageId: 'msg-1' };
    },
    async sendLongMessage(channelId, text) {
      sent.push({ channelId, text });
    },
    async sendCard(channelId, card) {
      cards.push({ channelId, card });
    },
    async deleteMessage() {},
    async sendTypingIndicator() {},

    onCommand(handler) {
      commandHandlers.push(handler);
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onError(handler) {
      errorHandlers.push(handler);
    },

    // Helper to simulate a command
    async simulateCommand(command, args, channelId = 'C123') {
      const ctx = {
        channelId,
        reply: async (text) => { sent.push({ channelId, text }); }
      };
      for (const h of commandHandlers) {
        await h(ctx, command, args);
      }
    }
  };
}

/**
 * Create a mock AI backend (local-mode style, no jobs map)
 */
function createMockLocalBackend() {
  const instances = new Map();
  const startCalls = [];
  const sendCalls = [];

  return {
    startCalls,
    sendCalls,
    startInstance(instanceId, projectDir, channelId, opts = {}) {
      startCalls.push({ instanceId, projectDir, channelId, opts });
      if (instances.has(instanceId)) {
        return { success: false, error: `Instance "${instanceId}" already running` };
      }
      instances.set(instanceId, { projectDir, channelId, opts, startedAt: new Date(), messageCount: 0 });
      return { success: true, sessionId: 'session-abc' };
    },
    stopInstance(instanceId) {
      if (!instances.has(instanceId)) {
        return { success: false, error: `Instance "${instanceId}" not found` };
      }
      instances.delete(instanceId);
      return { success: true };
    },
    getInstance(instanceId) {
      return instances.get(instanceId) || null;
    },
    getInstanceByChannel(channelId) {
      for (const [instanceId, instance] of instances) {
        if (instance.channelId === channelId) return { instanceId, instance };
      }
      return null;
    },
    listInstances() {
      return Array.from(instances.entries()).map(([instanceId, inst]) => ({
        instanceId, ...inst
      }));
    },
    async sendToInstance(instanceId, message, options = {}) {
      const inst = instances.get(instanceId);
      if (!inst) return { success: false, error: 'not found' };
      inst.messageCount++;
      sendCalls.push({ instanceId, message, options });
      return { success: true, responses: ['done'], exitCode: 0 };
    }
  };
}

// ============================================
// Unified Command Tests
// ============================================

describe('Bot Engine — Unified Commands', () => {
  let chatProvider;
  let aiBackend;

  beforeEach(() => {
    chatProvider = createMockChatProvider();
    aiBackend = createMockLocalBackend();
    createBotEngine({ chatProvider, aiBackend, commandPrefix: 'od', aiName: 'TestAI' });
  });

  describe('generateName', () => {
    it('should produce unique short IDs', () => {
      const a = _test.generateName();
      const b = _test.generateName();
      assert.ok(a.startsWith('agent-'));
      assert.ok(b.startsWith('agent-'));
      assert.strictEqual(a.length, 10); // 'agent-' + 4 hex chars
      // Statistically unique
      assert.notStrictEqual(a, b);
    });
  });

  describe('handleStart', () => {
    it('should auto-generate name and default path when no args', async () => {
      await chatProvider.simulateCommand('start', '');
      assert.strictEqual(aiBackend.startCalls.length, 1);
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
      assert.strictEqual(call.projectDir, os.homedir());
    });

    it('should use provided name only', async () => {
      await chatProvider.simulateCommand('start', 'mybot');
      const call = aiBackend.startCalls[0];
      assert.strictEqual(call.instanceId, 'mybot');
      assert.strictEqual(call.projectDir, os.homedir());
    });

    it('should use provided name and path', async () => {
      await chatProvider.simulateCommand('start', 'mybot /tmp/code');
      const call = aiBackend.startCalls[0];
      assert.strictEqual(call.instanceId, 'mybot');
      assert.strictEqual(call.projectDir, '/tmp/code');
    });

    it('should extract --image flag', async () => {
      await chatProvider.simulateCommand('start', '--image my-agent');
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
      assert.deepStrictEqual(call.opts, { image: 'my-agent' });
    });

    it('should handle name + --image', async () => {
      await chatProvider.simulateCommand('start', 'mybot --image custom:v1');
      const call = aiBackend.startCalls[0];
      assert.strictEqual(call.instanceId, 'mybot');
      assert.deepStrictEqual(call.opts, { image: 'custom:v1' });
    });

    it('should handle --image with auto-name', async () => {
      await chatProvider.simulateCommand('start', '--image my-agent');
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
      assert.strictEqual(call.opts.image, 'my-agent');
    });

    it('should handle path that starts with /', async () => {
      await chatProvider.simulateCommand('start', '/home/user/project');
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
      assert.strictEqual(call.projectDir, '/home/user/project');
    });

    it('should expand ~ in path to homedir', async () => {
      await chatProvider.simulateCommand('start', '~/project');
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
      assert.strictEqual(call.projectDir, require('path').join(os.homedir(), 'project'));
    });

    it('should handle relative path . as path not name', async () => {
      await chatProvider.simulateCommand('start', '.');
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
      assert.strictEqual(call.projectDir, '.');
    });

    it('should handle relative path ./repo as path not name', async () => {
      await chatProvider.simulateCommand('start', './repo');
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
      assert.strictEqual(call.projectDir, './repo');
    });

    it('should handle relative path ../repo as path not name', async () => {
      await chatProvider.simulateCommand('start', '../repo');
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
      assert.strictEqual(call.projectDir, '../repo');
    });

    it('should handle path with slashes (projects/api) as path not name', async () => {
      await chatProvider.simulateCommand('start', 'projects/api');
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
      assert.strictEqual(call.projectDir, 'projects/api');
    });

    it('should error when --image has no value', async () => {
      await chatProvider.simulateCommand('start', '--image');
      assert.ok(chatProvider.sent.some(m => m.text && m.text.includes('Missing value for --image')));
      assert.strictEqual(aiBackend.startCalls.length, 0);
    });

    it('should error on unterminated quote', async () => {
      await chatProvider.simulateCommand('start', '"mybot');
      assert.ok(chatProvider.sent.some(m => m.text && m.text.includes('Unterminated quote')));
      assert.strictEqual(aiBackend.startCalls.length, 0);
    });
  });

  describe('handleRun', () => {
    it('should show usage when no task provided', async () => {
      await chatProvider.simulateCommand('run', '');
      assert.ok(chatProvider.sent.some(m => m.text && m.text.includes('Usage')));
      assert.strictEqual(aiBackend.startCalls.length, 0);
    });

    it('should run task with auto-generated name', async () => {
      await chatProvider.simulateCommand('run', 'fix the tests');
      assert.strictEqual(aiBackend.startCalls.length, 1);
      const call = aiBackend.startCalls[0];
      assert.ok(call.instanceId.startsWith('agent-'));
    });

    it('should extract --image flag from run args', async () => {
      await chatProvider.simulateCommand('run', '--image custom "fix tests"');
      // The instance was started (the run creates a temp instance)
      assert.strictEqual(aiBackend.startCalls.length, 1);
    });

    it('should work with local backend (no jobs map)', async () => {
      // Our mock backend has no .jobs property, proving the guard is removed
      assert.strictEqual(aiBackend.jobs, undefined);
      await chatProvider.simulateCommand('run', 'do something');
      assert.strictEqual(aiBackend.startCalls.length, 1);
    });

    it('should not extract --image from inside quoted task', async () => {
      await chatProvider.simulateCommand('run', '"document --image foo behavior"');
      assert.strictEqual(aiBackend.startCalls.length, 1);
      // --image should NOT be extracted as a flag
      assert.deepStrictEqual(aiBackend.startCalls[0].opts, {});
      // sendToInstance should receive the full quoted string as the task
      assert.strictEqual(aiBackend.sendCalls.length, 1);
      assert.strictEqual(aiBackend.sendCalls[0].message, 'document --image foo behavior');
    });

    it('should error when --image has no value', async () => {
      await chatProvider.simulateCommand('run', '--image');
      assert.ok(chatProvider.sent.some(m => m.text && m.text.includes('Missing value for --image')));
      assert.strictEqual(aiBackend.startCalls.length, 0);
    });

    it('should pass image to startInstance opts', async () => {
      await chatProvider.simulateCommand('run', '--image custom:v1 "fix tests"');
      assert.strictEqual(aiBackend.startCalls.length, 1);
      const call = aiBackend.startCalls[0];
      assert.deepStrictEqual(call.opts, { image: 'custom:v1' });
    });
  });

  describe('handleStop', () => {
    it('should stop a named instance', async () => {
      await chatProvider.simulateCommand('start', 'mybot');
      await chatProvider.simulateCommand('stop', 'mybot');
      assert.strictEqual(aiBackend.getInstance('mybot'), null);
    });

    it('should show usage when no args', async () => {
      await chatProvider.simulateCommand('stop', '');
      assert.ok(chatProvider.sent.some(m => m.text && m.text.includes('Usage')));
    });

    it('should stop all instances with --all', async () => {
      await chatProvider.simulateCommand('start', 'bot-a');
      await chatProvider.simulateCommand('start', 'bot-b');
      assert.strictEqual(aiBackend.listInstances().length, 2);

      await chatProvider.simulateCommand('stop', '--all');
      assert.strictEqual(aiBackend.listInstances().length, 0);
    });

    it('should report when --all has nothing to stop', async () => {
      await chatProvider.simulateCommand('stop', '--all');
      assert.ok(chatProvider.sent.some(m => m.text && m.text.includes('No instances running')));
    });
  });

  describe('tokenize', () => {
    it('should split simple words', () => {
      assert.deepStrictEqual(_test.tokenize('a b c'), ['a', 'b', 'c']);
    });

    it('should keep quoted strings as single tokens', () => {
      assert.deepStrictEqual(_test.tokenize('--image foo "run the tests"'), ['--image', 'foo', 'run the tests']);
    });

    it('should handle single quotes', () => {
      assert.deepStrictEqual(_test.tokenize("'hello world'"), ['hello world']);
    });

    it('should not extract flags inside quotes', () => {
      const tokens = _test.tokenize('"document --image foo behavior"');
      assert.deepStrictEqual(tokens, ['document --image foo behavior']);
    });

    it('should handle empty input', () => {
      assert.deepStrictEqual(_test.tokenize(''), []);
    });

    it('should return error for unterminated double quote', () => {
      const result = _test.tokenize('"do thing');
      assert.ok(result.error);
      assert.ok(result.error.includes('Unterminated quote'));
    });

    it('should return error for unterminated single quote', () => {
      const result = _test.tokenize("'do thing");
      assert.ok(result.error);
      assert.ok(result.error.includes('Unterminated quote'));
    });
  });

  describe('looksLikePath', () => {
    it('should detect absolute paths', () => {
      assert.strictEqual(_test.looksLikePath('/home/user'), true);
    });

    it('should detect ~ paths', () => {
      assert.strictEqual(_test.looksLikePath('~/project'), true);
    });

    it('should detect relative dot paths', () => {
      assert.strictEqual(_test.looksLikePath('.'), true);
      assert.strictEqual(_test.looksLikePath('..'), true);
      assert.strictEqual(_test.looksLikePath('./repo'), true);
      assert.strictEqual(_test.looksLikePath('../repo'), true);
    });

    it('should detect paths with slashes', () => {
      assert.strictEqual(_test.looksLikePath('projects/api'), true);
    });

    it('should not detect plain names as paths', () => {
      assert.strictEqual(_test.looksLikePath('mybot'), false);
      assert.strictEqual(_test.looksLikePath('agent-7k3f'), false);
    });
  });

  describe('help text', () => {
    it('should show unified commands on unknown command', async () => {
      await chatProvider.simulateCommand('unknown', '');
      const helpMsg = chatProvider.sent.find(m => m.text && m.text.includes('Available commands'));
      assert.ok(helpMsg);
      assert.ok(helpMsg.text.includes('--image'));
      assert.ok(helpMsg.text.includes('--all'));
      assert.ok(!helpMsg.text.includes('--repo'));
      assert.ok(!helpMsg.text.includes('--branch'));
    });
  });
});

// ============================================
// Mock Chat Provider (for batcher / routing / alias tests)
// ============================================

function createStreamingMockChatProvider() {
  const sentMessages = [];
  const commandHandlers = [];
  const messageHandlers = [];
  const errorHandlers = [];

  return {
    name: 'mock',
    supportsCards: false,

    sentMessages,

    async initialize() {},
    async start() {},
    async stop() {},

    onCommand(handler) { commandHandlers.push(handler); },
    onMessage(handler) { messageHandlers.push(handler); },
    onError(handler) { errorHandlers.push(handler); },

    async sendMessage(channelId, text) {
      sentMessages.push({ channelId, text, type: 'message' });
      return { messageId: `msg-${sentMessages.length}` };
    },

    async sendLongMessage(channelId, text) {
      sentMessages.push({ channelId, text, type: 'long' });
    },

    async sendTypingIndicator(channelId) {
      sentMessages.push({ channelId, type: 'typing' });
    },

    async deleteMessage(channelId, messageId) {
      sentMessages.push({ channelId, messageId, type: 'delete' });
    },

    async sendCard(channelId, card) {
      sentMessages.push({ channelId, card, type: 'card' });
    },

    // Fire a command handler (simulates incoming command)
    async fireCommand(ctx, command, args) {
      for (const handler of commandHandlers) {
        await handler(ctx, command, args);
      }
    },

    // Fire a message handler (simulates incoming message)
    async fireMessage(ctx, text) {
      for (const handler of messageHandlers) {
        await handler(ctx, text);
      }
    }
  };
}

// ============================================
// Mock AI Backend (sprite-core-like, with jobs map)
// ============================================

function createStreamingMockAIBackend(options = {}) {
  const instances = new Map();
  const jobs = new Map();

  return {
    instances,
    jobs,

    async startInstance(instanceId, projectDir, channelId, opts = {}) {
      if (instances.has(instanceId)) {
        return { success: false, error: `Instance "${instanceId}" already running` };
      }
      instances.set(instanceId, {
        instanceId,
        projectDir,
        channelId,
        messageCount: 0,
        startedAt: new Date()
      });
      return { success: true, sessionId: 'mock-session-123' };
    },

    stopInstance(instanceId) {
      if (!instances.has(instanceId)) {
        return { success: false, error: `Instance "${instanceId}" not found` };
      }
      instances.delete(instanceId);
      return { success: true };
    },

    getInstance(instanceId) {
      return instances.get(instanceId) || null;
    },

    getInstanceByChannel(channelId) {
      for (const [instanceId, instance] of instances) {
        if (instance.channelId === channelId) {
          return { instanceId, instance };
        }
      }
      return null;
    },

    listInstances() {
      return Array.from(instances.entries()).map(([id, inst]) => ({
        instanceId: id,
        ...inst
      }));
    },

    async sendToInstance(instanceId, message, opts = {}) {
      const instance = instances.get(instanceId);
      if (!instance) {
        return { success: false, error: `Instance "${instanceId}" not found` };
      }
      instance.messageCount++;

      // If there's an onMessage callback, fire it to test batcher behavior
      if (opts.onMessage) {
        if (options.streamMessages) {
          for (const msg of options.streamMessages) {
            await opts.onMessage(msg);
          }
        }
      }

      if (options.sendError) {
        return { success: false, error: options.sendError };
      }

      return {
        success: true,
        responses: options.responses || ['Mock response'],
        jobId: 'mock-job-123',
        artifacts: options.artifacts || []
      };
    },

    listJobs() {
      return Array.from(jobs.values());
    }
  };
}

// ============================================
// Message Batcher Error Handling Tests
// ============================================

describe('Bot Engine - Message Batcher Error Handling', () => {
  it('should not crash when chatProvider.sendLongMessage throws during flush', async () => {
    let sendCallCount = 0;
    const chatProvider = createStreamingMockChatProvider();

    // Override sendLongMessage to throw on first call, succeed on subsequent
    const originalSendLong = chatProvider.sendLongMessage;
    chatProvider.sendLongMessage = async (channelId, text) => {
      sendCallCount++;
      if (sendCallCount === 1) {
        throw new Error('Slack API rate limited');
      }
      return originalSendLong.call(chatProvider, channelId, text);
    };

    const aiBackend = createStreamingMockAIBackend({
      streamMessages: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6']
    });

    const bot = createBotEngine({
      chatProvider,
      aiBackend,
      aiName: 'Test',
      showThinking: false,
      streamResponses: true
    });

    // Start an instance via the backend directly
    await aiBackend.startInstance('test', '/project', 'C123');

    // Fire a run command that will use the batcher
    const ctx = { channelId: 'C123', reply: async (text) => {} };
    await chatProvider.fireCommand(ctx, 'run', '--image test "do stuff"');

    // The bot should not have crashed — the test completing is itself the assertion.
    // But also verify no unhandled errors propagated.
    assert.ok(true, 'Bot engine survived flush error without crashing');
  });

  it('should continue processing messages after a flush error', async () => {
    let sendCallCount = 0;
    let successfulSends = 0;
    const chatProvider = createStreamingMockChatProvider();

    chatProvider.sendLongMessage = async (channelId, text) => {
      sendCallCount++;
      if (sendCallCount <= 1) {
        throw new Error('temporary API error');
      }
      successfulSends++;
    };

    const aiBackend = createStreamingMockAIBackend({
      // Stream enough messages to trigger multiple flushes
      streamMessages: [
        'batch1-line1', 'batch1-line2', 'batch1-line3', 'batch1-line4', 'batch1-line5',
        'batch2-line1', 'batch2-line2', 'batch2-line3', 'batch2-line4', 'batch2-line5'
      ]
    });

    const bot = createBotEngine({
      chatProvider,
      aiBackend,
      aiName: 'Test',
      showThinking: false,
      streamResponses: true
    });

    await aiBackend.startInstance('test', '/project', 'C123');

    const ctx = { channelId: 'C123', reply: async () => {} };
    await chatProvider.fireCommand(ctx, 'run', '--image test "do stuff"');

    // Even though the first send failed, subsequent sends should have gone through
    assert.ok(sendCallCount > 1,
      'Multiple flush attempts should have been made');
  });
});

// ============================================
// Bot Engine command routing tests
// ============================================

describe('Bot Engine - Command Routing', () => {
  it('should route messages to the correct instance by channel', async () => {
    const chatProvider = createStreamingMockChatProvider();
    const aiBackend = createStreamingMockAIBackend({
      responses: ['Hello from AI']
    });

    const bot = createBotEngine({
      chatProvider,
      aiBackend,
      aiName: 'Test',
      showThinking: false,
      streamResponses: false
    });

    // Start instance linked to a channel
    await aiBackend.startInstance('my-project', '/project', 'C123');

    // Fire a message on that channel
    const ctx = {
      channelId: 'C123',
      reply: async (text) => {
        chatProvider.sentMessages.push({ text, type: 'reply' });
      }
    };
    await chatProvider.fireMessage(ctx, 'run tests');

    const instance = aiBackend.getInstance('my-project');
    assert.strictEqual(instance.messageCount, 1);
  });

  it('should ignore messages on channels without an active instance', async () => {
    const chatProvider = createStreamingMockChatProvider();
    const aiBackend = createStreamingMockAIBackend();

    const bot = createBotEngine({
      chatProvider,
      aiBackend,
      aiName: 'Test',
      showThinking: false
    });

    const ctx = {
      channelId: 'C-NO-INSTANCE',
      reply: async (text) => {
        chatProvider.sentMessages.push({ text, type: 'reply' });
      }
    };
    await chatProvider.fireMessage(ctx, 'hello');

    // No messages should be sent (no instance, so message is silently ignored)
    const nonTyping = chatProvider.sentMessages.filter(m => m.type !== 'typing');
    assert.strictEqual(nonTyping.length, 0,
      'No responses should be sent for channels without instances');
  });
});

// ============================================
// Image Alias Resolution Tests
// ============================================

describe('Bot Engine - Image Alias Resolution', () => {
  it('should resolve image alias from SPRITE_IMAGES env var', async () => {
    const originalEnv = process.env.SPRITE_IMAGES;
    process.env.SPRITE_IMAGES = JSON.stringify({
      web: 'ghcr.io/myorg/web-sprite:latest',
      api: 'ghcr.io/myorg/api-sprite:latest'
    });

    let capturedImage = null;
    const chatProvider = createStreamingMockChatProvider();
    const aiBackend = createStreamingMockAIBackend();

    // Capture the image passed to sendToInstance
    const originalSend = aiBackend.sendToInstance.bind(aiBackend);
    aiBackend.sendToInstance = async (instanceId, message, opts) => {
      capturedImage = opts.image;
      return originalSend(instanceId, message, opts);
    };

    const bot = createBotEngine({
      chatProvider,
      aiBackend,
      aiName: 'Test',
      showThinking: false,
      streamResponses: false
    });

    await aiBackend.startInstance('test', '/project', 'C123');
    const ctx = { channelId: 'C123', reply: async () => {} };
    await chatProvider.fireCommand(ctx, 'run', '--image web "do stuff"');

    assert.strictEqual(capturedImage, 'ghcr.io/myorg/web-sprite:latest',
      'Image alias should resolve to full URL');

    // Cleanup
    if (originalEnv === undefined) {
      delete process.env.SPRITE_IMAGES;
    } else {
      process.env.SPRITE_IMAGES = originalEnv;
    }
  });

  it('should pass through full image URLs unchanged', async () => {
    const originalEnv = process.env.SPRITE_IMAGES;
    process.env.SPRITE_IMAGES = JSON.stringify({ web: 'ghcr.io/myorg/web-sprite:latest' });

    let capturedImage = null;
    const chatProvider = createStreamingMockChatProvider();
    const aiBackend = createStreamingMockAIBackend();

    const originalSend = aiBackend.sendToInstance.bind(aiBackend);
    aiBackend.sendToInstance = async (instanceId, message, opts) => {
      capturedImage = opts.image;
      return originalSend(instanceId, message, opts);
    };

    const bot = createBotEngine({
      chatProvider,
      aiBackend,
      aiName: 'Test',
      showThinking: false,
      streamResponses: false
    });

    await aiBackend.startInstance('test', '/project', 'C123');
    const ctx = { channelId: 'C123', reply: async () => {} };
    await chatProvider.fireCommand(ctx, 'run', '--image ghcr.io/other/image:v2 "do stuff"');

    assert.strictEqual(capturedImage, 'ghcr.io/other/image:v2',
      'Unrecognized image names should pass through as-is');

    if (originalEnv === undefined) {
      delete process.env.SPRITE_IMAGES;
    } else {
      process.env.SPRITE_IMAGES = originalEnv;
    }
  });

  it('should work when SPRITE_IMAGES is not set', async () => {
    const originalEnv = process.env.SPRITE_IMAGES;
    delete process.env.SPRITE_IMAGES;

    let capturedImage = null;
    const chatProvider = createStreamingMockChatProvider();
    const aiBackend = createStreamingMockAIBackend();

    const originalSend = aiBackend.sendToInstance.bind(aiBackend);
    aiBackend.sendToInstance = async (instanceId, message, opts) => {
      capturedImage = opts.image;
      return originalSend(instanceId, message, opts);
    };

    const bot = createBotEngine({
      chatProvider,
      aiBackend,
      aiName: 'Test',
      showThinking: false,
      streamResponses: false
    });

    await aiBackend.startInstance('test', '/project', 'C123');
    const ctx = { channelId: 'C123', reply: async () => {} };
    await chatProvider.fireCommand(ctx, 'run', '--image my-image:v1 "do stuff"');

    assert.strictEqual(capturedImage, 'my-image:v1',
      'Image should pass through when SPRITE_IMAGES is not set');

    if (originalEnv === undefined) {
      delete process.env.SPRITE_IMAGES;
    } else {
      process.env.SPRITE_IMAGES = originalEnv;
    }
  });

  it('should handle malformed SPRITE_IMAGES JSON gracefully', async () => {
    const originalEnv = process.env.SPRITE_IMAGES;
    process.env.SPRITE_IMAGES = 'not valid json';

    let capturedImage = null;
    const chatProvider = createStreamingMockChatProvider();
    const aiBackend = createStreamingMockAIBackend();

    const originalSend = aiBackend.sendToInstance.bind(aiBackend);
    aiBackend.sendToInstance = async (instanceId, message, opts) => {
      capturedImage = opts.image;
      return originalSend(instanceId, message, opts);
    };

    const bot = createBotEngine({
      chatProvider,
      aiBackend,
      aiName: 'Test',
      showThinking: false,
      streamResponses: false
    });

    await aiBackend.startInstance('test', '/project', 'C123');
    const ctx = { channelId: 'C123', reply: async () => {} };
    await chatProvider.fireCommand(ctx, 'run', '--image web "do stuff"');

    assert.strictEqual(capturedImage, 'web',
      'Should fall back to raw image name on invalid JSON');

    if (originalEnv === undefined) {
      delete process.env.SPRITE_IMAGES;
    } else {
      process.env.SPRITE_IMAGES = originalEnv;
    }
  });
});

// ============================================
// Unhandled Rejection Handler Verification
// ============================================

describe('Unhandled rejection handlers in entry points', () => {
  // These tests verify that each bot entry point file contains
  // process.on('unhandledRejection', ...) or equivalent handlers.
  // This is a static/grep-style check on the source code.

  const entryPoints = [
    { name: 'bot.js', path: path.join(__dirname, '../src/bot.js'), requiresSigint: true },
    { name: 'sprite-bot.js', path: path.join(__dirname, '../src/sprite-bot.js'), requiresSigint: true },
    { name: 'discord-bot.js', path: path.join(__dirname, '../src/discord-bot.js'), requiresSigint: true },
    { name: 'discord-opencode-bot.js', path: path.join(__dirname, '../src/discord-opencode-bot.js'), requiresSigint: true },
    { name: 'teams-bot.js', path: path.join(__dirname, '../src/teams-bot.js'), requiresSigint: true },
    { name: 'teams-opencode-bot.js', path: path.join(__dirname, '../src/teams-opencode-bot.js'), requiresSigint: true },
    { name: 'opencode-bot.js', path: path.join(__dirname, '../src/opencode-bot.js'), requiresSigint: true }
  ];

  for (const ep of entryPoints) {
    if (ep.requiresSigint) {
      it(`${ep.name} should have SIGINT handler`, () => {
        const source = fs.readFileSync(ep.path, 'utf8');
        assert.ok(
          source.includes("process.on('SIGINT'") ||
          source.includes('process.on("SIGINT"') ||
          source.includes('process.on(`SIGINT`'),
          `${ep.name} should have a SIGINT handler for graceful shutdown`
        );
      });
    }

    it(`${ep.name} should have unhandledRejection handler`, () => {
      const source = fs.readFileSync(ep.path, 'utf8');
      assert.ok(
        source.includes('unhandledRejection') ||
        source.includes('uncaughtException') ||
        source.includes('registerFatalHandlers'),
        `${ep.name} should have unhandledRejection or uncaughtException handler (or use registerFatalHandlers)`
      );
    });
  }

  it('sprite-bot.js should have SIGTERM handler', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../src/sprite-bot.js'), 'utf8'
    );
    assert.ok(
      source.includes('SIGTERM'),
      'sprite-bot.js should handle SIGTERM for container shutdown'
    );
  });
});

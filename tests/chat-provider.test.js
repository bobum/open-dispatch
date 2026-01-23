/**
 * Tests for the ChatProvider base class and provider registry
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  ChatProvider,
  registerProvider,
  getProvider,
  listProviders,
  createProvider
} = require('../src/providers/chat-provider');

// Import providers to register them
require('../src/providers/slack-provider');
require('../src/providers/teams-provider');
require('../src/providers/discord-provider');

// ============================================
// ChatProvider Base Class Tests
// ============================================

describe('ChatProvider Base Class', () => {
  it('should not be instantiable directly', () => {
    assert.throws(() => {
      new ChatProvider({});
    }, /abstract and cannot be instantiated/);
  });

  it('should allow subclasses to be instantiated', () => {
    class TestProvider extends ChatProvider {
      get name() { return 'test'; }
      get maxMessageLength() { return 1000; }
      async initialize() {}
      async start() {}
      async stop() {}
      async sendMessage() { return { messageId: '1' }; }
      async sendTypingIndicator() {}
      async deleteMessage() { return true; }
    }

    const provider = new TestProvider({ foo: 'bar' });
    assert.strictEqual(provider.name, 'test');
    assert.strictEqual(provider.maxMessageLength, 1000);
    assert.deepStrictEqual(provider.config, { foo: 'bar' });
  });

  it('should have default values for optional properties', () => {
    class TestProvider extends ChatProvider {
      get name() { return 'test'; }
      get maxMessageLength() { return 1000; }
      async initialize() {}
      async start() {}
      async stop() {}
      async sendMessage() { return { messageId: '1' }; }
      async sendTypingIndicator() {}
      async deleteMessage() { return true; }
    }

    const provider = new TestProvider({});
    assert.strictEqual(provider.supportsCards, false);
    assert.strictEqual(provider.supportsEphemeral, false);
    assert.strictEqual(provider.supportsThreads, false);
  });
});

// ============================================
// chunkText Tests
// ============================================

describe('ChatProvider.chunkText', () => {
  class TestProvider extends ChatProvider {
    get name() { return 'test'; }
    get maxMessageLength() { return 100; }
    async initialize() {}
    async start() {}
    async stop() {}
    async sendMessage() { return { messageId: '1' }; }
    async sendTypingIndicator() {}
    async deleteMessage() { return true; }
  }

  it('should return single chunk for short text', () => {
    const provider = new TestProvider({});
    const chunks = provider.chunkText('Hello world');
    assert.deepStrictEqual(chunks, ['Hello world']);
  });

  it('should split at newlines for long text', () => {
    const provider = new TestProvider({});
    // Create text that definitely exceeds 100 chars
    const lines = [];
    for (let i = 1; i <= 20; i++) {
      lines.push(`Line ${i} with some padding text`);
    }
    const text = lines.join('\n');
    const chunks = provider.chunkText(text);

    assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 100, `Chunk too long: ${chunk.length}`);
    }
  });

  it('should split at spaces if no newline', () => {
    const provider = new TestProvider({});
    // Create text that definitely exceeds 100 chars without newlines
    const text = 'word '.repeat(30).trim(); // 150 chars
    const chunks = provider.chunkText(text);

    assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}. Text length: ${text.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 100, `Chunk too long: ${chunk.length}`);
    }
  });

  it('should use custom max length', () => {
    const provider = new TestProvider({});
    const text = 'Short text here';
    const chunks = provider.chunkText(text, 5);

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 5);
    }
  });
});

// ============================================
// Event Handler Tests
// ============================================

describe('ChatProvider Event Handlers', () => {
  class TestProvider extends ChatProvider {
    get name() { return 'test'; }
    get maxMessageLength() { return 1000; }
    async initialize() {}
    async start() {}
    async stop() {}
    async sendMessage() { return { messageId: '1' }; }
    async sendTypingIndicator() {}
    async deleteMessage() { return true; }

    // Expose protected methods for testing
    async testEmitMessage(ctx, text) {
      return this._emitMessage(ctx, text);
    }
    async testEmitCommand(ctx, command, args) {
      return this._emitCommand(ctx, command, args);
    }
    testCreateContext(params) {
      return this._createContext(params);
    }
  }

  it('should register and invoke message handler', async () => {
    const provider = new TestProvider({});
    let receivedCtx = null;
    let receivedText = null;

    provider.onMessage(async (ctx, text) => {
      receivedCtx = ctx;
      receivedText = text;
    });

    const ctx = provider.testCreateContext({
      channelId: 'ch1',
      userId: 'user1',
      raw: {}
    });

    await provider.testEmitMessage(ctx, 'Hello');

    assert.strictEqual(receivedCtx.channelId, 'ch1');
    assert.strictEqual(receivedText, 'Hello');
  });

  it('should register and invoke command handler', async () => {
    const provider = new TestProvider({});
    let receivedCommand = null;
    let receivedArgs = null;

    provider.onCommand(async (ctx, command, args) => {
      receivedCommand = command;
      receivedArgs = args;
    });

    const ctx = provider.testCreateContext({
      channelId: 'ch1',
      userId: 'user1',
      raw: {}
    });

    await provider.testEmitCommand(ctx, 'start', 'myproject /path/to/dir');

    assert.strictEqual(receivedCommand, 'start');
    assert.strictEqual(receivedArgs, 'myproject /path/to/dir');
  });

  it('should create context with reply method', async () => {
    const provider = new TestProvider({});

    const ctx = provider.testCreateContext({
      channelId: 'ch1',
      userId: 'user1',
      userName: 'testuser',
      messageId: 'msg1',
      raw: { foo: 'bar' }
    });

    assert.strictEqual(ctx.channelId, 'ch1');
    assert.strictEqual(ctx.userId, 'user1');
    assert.strictEqual(ctx.userName, 'testuser');
    assert.strictEqual(ctx.messageId, 'msg1');
    assert.deepStrictEqual(ctx.raw, { foo: 'bar' });
    assert.strictEqual(typeof ctx.reply, 'function');
  });
});

// ============================================
// Provider Registry Tests
// ============================================

describe('Provider Registry', () => {
  beforeEach(() => {
    // Note: Registry persists between tests, so providers registered
    // in other test files will be present
  });

  it('should list registered providers', () => {
    const providers = listProviders();
    assert.ok(Array.isArray(providers));
    // At minimum, slack, teams, discord should be registered from imports
    assert.ok(providers.includes('slack'));
    assert.ok(providers.includes('teams'));
    assert.ok(providers.includes('discord'));
  });

  it('should get a registered provider', () => {
    const SlackProvider = getProvider('slack');
    assert.ok(SlackProvider);
    assert.strictEqual(typeof SlackProvider, 'function');
  });

  it('should return null for unknown provider', () => {
    const Unknown = getProvider('nonexistent');
    assert.strictEqual(Unknown, null);
  });

  it('should throw when creating unknown provider', () => {
    assert.throws(() => {
      createProvider('nonexistent', {});
    }, /Unknown provider/);
  });
});

// ============================================
// CardData to Text Conversion Tests
// ============================================

describe('ChatProvider._cardToText', () => {
  class TestProvider extends ChatProvider {
    get name() { return 'test'; }
    get maxMessageLength() { return 1000; }
    async initialize() {}
    async start() {}
    async stop() {}
    async sendMessage() { return { messageId: '1' }; }
    async sendTypingIndicator() {}
    async deleteMessage() { return true; }

    testCardToText(cardData) {
      return this._cardToText(cardData);
    }
  }

  it('should convert card with title and description', () => {
    const provider = new TestProvider({});
    const text = provider.testCardToText({
      title: 'Test Title',
      description: 'Test description'
    });

    assert.ok(text.includes('**Test Title**'));
    assert.ok(text.includes('Test description'));
  });

  it('should convert card with fields', () => {
    const provider = new TestProvider({});
    const text = provider.testCardToText({
      title: 'Test',
      fields: [
        { name: 'Field1', value: 'Value1' },
        { name: 'Field2', value: 'Value2' }
      ]
    });

    assert.ok(text.includes('Field1: Value1'));
    assert.ok(text.includes('Field2: Value2'));
  });

  it('should convert card with footer', () => {
    const provider = new TestProvider({});
    const text = provider.testCardToText({
      title: 'Test',
      footer: 'Footer text'
    });

    assert.ok(text.includes('_Footer text_'));
  });
});

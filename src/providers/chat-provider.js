/**
 * ChatProvider Base Class
 *
 * Abstract interface that all chat platform providers must implement.
 * This enables plug-and-play support for different chat platforms
 * (Slack, Teams, Discord, etc.) with the same bot engine.
 */

/**
 * @typedef {Object} MessageContext
 * @property {string} channelId - Platform-specific channel/conversation identifier
 * @property {string} userId - Platform-specific user identifier
 * @property {string} [userName] - User's display name (if available)
 * @property {string} [messageId] - Platform-specific message ID
 * @property {Object} raw - Platform-specific raw event/activity data
 * @property {Function} reply - Convenience method to reply in same channel
 */

/**
 * @typedef {Object} SendMessageOptions
 * @property {boolean} [ephemeral] - Only visible to the user (if supported)
 * @property {string} [replyTo] - Message ID to reply to (threading)
 * @property {Object} [embed] - Rich embed/card data
 */

/**
 * @typedef {Object} CardData
 * @property {string} title - Card title
 * @property {string} [description] - Card description/body
 * @property {string} [color] - Accent color (hex or name)
 * @property {Array<{name: string, value: string}>} [fields] - Key-value fields
 * @property {string} [footer] - Footer text
 */

/**
 * Abstract ChatProvider class
 *
 * Subclasses must implement all methods marked with @abstract
 */
class ChatProvider {
  /**
   * @param {Object} config - Provider-specific configuration
   */
  constructor(config = {}) {
    if (new.target === ChatProvider) {
      throw new Error('ChatProvider is abstract and cannot be instantiated directly');
    }

    this.config = config;
    this._messageHandler = null;
    this._commandHandler = null;
    this._errorHandler = null;
  }

  // ============================================
  // ABSTRACT PROPERTIES (must be overridden)
  // ============================================

  /**
   * Provider name identifier
   * @abstract
   * @returns {string} e.g., 'slack', 'teams', 'discord'
   */
  get name() {
    throw new Error('Subclass must implement name getter');
  }

  /**
   * Maximum message length for this platform
   * @abstract
   * @returns {number} Character limit (e.g., 4000 for Slack, 2000 for Discord)
   */
  get maxMessageLength() {
    throw new Error('Subclass must implement maxMessageLength getter');
  }

  /**
   * Whether the platform supports rich cards/embeds
   * @returns {boolean}
   */
  get supportsCards() {
    return false;
  }

  /**
   * Whether the platform supports ephemeral messages
   * @returns {boolean}
   */
  get supportsEphemeral() {
    return false;
  }

  /**
   * Whether the platform supports threading
   * @returns {boolean}
   */
  get supportsThreads() {
    return false;
  }

  // ============================================
  // LIFECYCLE METHODS
  // ============================================

  /**
   * Initialize the provider (setup SDK, validate config)
   * @abstract
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('Subclass must implement initialize()');
  }

  /**
   * Start listening for events
   * @abstract
   * @returns {Promise<void>}
   */
  async start() {
    throw new Error('Subclass must implement start()');
  }

  /**
   * Graceful shutdown
   * @abstract
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error('Subclass must implement stop()');
  }

  // ============================================
  // MESSAGING METHODS
  // ============================================

  /**
   * Send a text message to a channel
   * @abstract
   * @param {string} channelId - Target channel/conversation
   * @param {string} text - Message text
   * @param {SendMessageOptions} [options] - Additional options
   * @returns {Promise<{messageId: string}>}
   */
  async sendMessage(channelId, text, options = {}) {
    throw new Error('Subclass must implement sendMessage()');
  }

  /**
   * Send a rich card/embed to a channel
   * @param {string} channelId - Target channel/conversation
   * @param {CardData} cardData - Card content
   * @returns {Promise<{messageId: string}>}
   */
  async sendCard(channelId, cardData) {
    // Default implementation: fall back to plain text
    const text = this._cardToText(cardData);
    return this.sendMessage(channelId, text);
  }

  /**
   * Send typing indicator
   * @abstract
   * @param {string} channelId - Target channel/conversation
   * @returns {Promise<void>}
   */
  async sendTypingIndicator(channelId) {
    throw new Error('Subclass must implement sendTypingIndicator()');
  }

  /**
   * Delete a message
   * @abstract
   * @param {string} channelId - Channel containing the message
   * @param {string} messageId - Message to delete
   * @returns {Promise<boolean>} Success status
   */
  async deleteMessage(channelId, messageId) {
    throw new Error('Subclass must implement deleteMessage()');
  }

  /**
   * Edit an existing message
   * @param {string} channelId - Channel containing the message
   * @param {string} messageId - Message to edit
   * @param {string} newText - New message content
   * @returns {Promise<boolean>} Success status
   */
  async editMessage(channelId, messageId, newText) {
    // Default: not supported, return false
    return false;
  }

  // ============================================
  // EVENT REGISTRATION
  // ============================================

  /**
   * Register handler for incoming messages
   * @param {(ctx: MessageContext, text: string) => Promise<void>} handler
   */
  onMessage(handler) {
    this._messageHandler = handler;
  }

  /**
   * Register handler for commands
   * Commands are platform-specific (slash commands, prefix commands, etc.)
   * @param {(ctx: MessageContext, command: string, args: string) => Promise<void>} handler
   */
  onCommand(handler) {
    this._commandHandler = handler;
  }

  /**
   * Register error handler
   * @param {(error: Error, ctx?: MessageContext) => Promise<void>} handler
   */
  onError(handler) {
    this._errorHandler = handler;
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Chunk text for platform message limits
   * @param {string} text - Text to chunk
   * @param {number} [maxLength] - Override max length
   * @returns {string[]} Array of chunks
   */
  chunkText(text, maxLength) {
    const limit = maxLength || this.maxMessageLength;
    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point
      let breakPoint = remaining.lastIndexOf('\n', limit);
      if (breakPoint === -1 || breakPoint < limit / 2) {
        breakPoint = remaining.lastIndexOf(' ', limit);
      }
      if (breakPoint === -1 || breakPoint < limit / 2) {
        breakPoint = limit;
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trim();
    }

    return chunks;
  }

  /**
   * Send a long message, automatically chunking if needed
   * @param {string} channelId - Target channel
   * @param {string} text - Message text (may exceed limit)
   * @param {SendMessageOptions} [options] - Additional options
   * @returns {Promise<{messageIds: string[]}>}
   */
  async sendLongMessage(channelId, text, options = {}) {
    const chunks = this.chunkText(text);
    const messageIds = [];

    for (const chunk of chunks) {
      const result = await this.sendMessage(channelId, chunk, options);
      if (result.messageId) {
        messageIds.push(result.messageId);
      }
    }

    return { messageIds };
  }

  /**
   * Convert CardData to plain text (fallback for platforms without card support)
   * @protected
   * @param {CardData} cardData
   * @returns {string}
   */
  _cardToText(cardData) {
    const lines = [];

    if (cardData.title) {
      lines.push(`**${cardData.title}**`);
    }
    if (cardData.description) {
      lines.push(cardData.description);
    }
    if (cardData.fields && cardData.fields.length > 0) {
      lines.push('');
      for (const field of cardData.fields) {
        lines.push(`${field.name}: ${field.value}`);
      }
    }
    if (cardData.footer) {
      lines.push('');
      lines.push(`_${cardData.footer}_`);
    }

    return lines.join('\n');
  }

  /**
   * Create a standardized MessageContext
   * @protected
   * @param {Object} params
   * @returns {MessageContext}
   */
  _createContext(params) {
    const { channelId, userId, userName, messageId, raw } = params;

    return {
      channelId,
      userId,
      userName: userName || null,
      messageId: messageId || null,
      raw: raw || {},
      reply: async (text, options) => {
        return this.sendMessage(channelId, text, options);
      }
    };
  }

  /**
   * Safely invoke the message handler
   * @protected
   * @param {MessageContext} ctx
   * @param {string} text
   */
  async _emitMessage(ctx, text) {
    if (this._messageHandler) {
      try {
        await this._messageHandler(ctx, text);
      } catch (error) {
        await this._emitError(error, ctx);
      }
    }
  }

  /**
   * Safely invoke the command handler
   * @protected
   * @param {MessageContext} ctx
   * @param {string} command
   * @param {string} args
   */
  async _emitCommand(ctx, command, args) {
    if (this._commandHandler) {
      try {
        await this._commandHandler(ctx, command, args);
      } catch (error) {
        await this._emitError(error, ctx);
      }
    }
  }

  /**
   * Safely invoke the error handler
   * @protected
   * @param {Error} error
   * @param {MessageContext} [ctx]
   */
  async _emitError(error, ctx) {
    console.error(`[${this.name}] Error:`, error);
    if (this._errorHandler) {
      try {
        await this._errorHandler(error, ctx);
      } catch (handlerError) {
        console.error(`[${this.name}] Error handler failed:`, handlerError);
      }
    }
  }
}

// ============================================
// PROVIDER REGISTRY
// ============================================

/**
 * Registry for available chat providers
 */
const providerRegistry = new Map();

/**
 * Register a provider class
 * @param {string} name - Provider name
 * @param {typeof ChatProvider} ProviderClass - Provider class
 */
function registerProvider(name, ProviderClass) {
  providerRegistry.set(name.toLowerCase(), ProviderClass);
}

/**
 * Get a registered provider class
 * @param {string} name - Provider name
 * @returns {typeof ChatProvider|null}
 */
function getProvider(name) {
  return providerRegistry.get(name.toLowerCase()) || null;
}

/**
 * List all registered providers
 * @returns {string[]}
 */
function listProviders() {
  return Array.from(providerRegistry.keys());
}

/**
 * Create a provider instance
 * @param {string} name - Provider name
 * @param {Object} config - Provider configuration
 * @returns {ChatProvider}
 */
function createProvider(name, config) {
  const ProviderClass = getProvider(name);
  if (!ProviderClass) {
    throw new Error(`Unknown provider: ${name}. Available: ${listProviders().join(', ')}`);
  }
  return new ProviderClass(config);
}

module.exports = {
  ChatProvider,
  registerProvider,
  getProvider,
  listProviders,
  createProvider
};

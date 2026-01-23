/**
 * Microsoft Teams Chat Provider
 *
 * Implements the ChatProvider interface for Microsoft Teams using botbuilder.
 * Requires a public HTTPS endpoint (use ngrok for local development).
 */

const { ChatProvider, registerProvider } = require('./chat-provider');

// botbuilder and restify are imported dynamically
let BotFrameworkAdapter, ActivityTypes, CardFactory, TurnContext, restify;

/**
 * Teams-specific configuration
 * @typedef {Object} TeamsConfig
 * @property {string} appId - Microsoft App ID
 * @property {string} appPassword - Microsoft App Password
 * @property {string} [tenantId] - Azure AD Tenant ID (for single-tenant bots)
 * @property {number} [port=3978] - Server port
 * @property {string} [commandPrefix='claude'] - Prefix for text commands
 */

class TeamsProvider extends ChatProvider {
  /**
   * @param {TeamsConfig} config
   */
  constructor(config) {
    super(config);

    this.adapter = null;
    this.server = null;
    this._isInitialized = false;
    this._conversationReferences = new Map();
    this._pendingContexts = new Map(); // For async operations

    // Validate required config
    if (!config.appId) {
      throw new Error('Teams provider requires appId (MICROSOFT_APP_ID)');
    }
    if (!config.appPassword) {
      throw new Error('Teams provider requires appPassword (MICROSOFT_APP_PASSWORD)');
    }

    // Set defaults
    this.config = {
      port: 3978,
      commandPrefix: 'claude',
      ...config
    };
  }

  get name() {
    return 'teams';
  }

  get maxMessageLength() {
    return 25000; // Teams limit is ~28KB, leave buffer
  }

  get supportsCards() {
    return true; // Teams Adaptive Cards
  }

  get supportsEphemeral() {
    return false; // Teams doesn't support ephemeral messages
  }

  get supportsThreads() {
    return true; // Teams has reply threading
  }

  /**
   * Initialize Teams adapter and server
   */
  async initialize() {
    if (this._isInitialized) return;

    // Dynamic imports
    try {
      const botbuilder = require('botbuilder');
      BotFrameworkAdapter = botbuilder.BotFrameworkAdapter;
      ActivityTypes = botbuilder.ActivityTypes;
      CardFactory = botbuilder.CardFactory;
      TurnContext = botbuilder.TurnContext;
    } catch (error) {
      throw new Error(
        'botbuilder is not installed. Run: npm install botbuilder'
      );
    }

    try {
      restify = require('restify');
    } catch (error) {
      throw new Error(
        'restify is not installed. Run: npm install restify'
      );
    }

    // Create Bot Framework adapter
    this.adapter = new BotFrameworkAdapter({
      appId: this.config.appId,
      appPassword: this.config.appPassword,
      channelAuthTenant: this.config.tenantId
    });

    // Error handling
    this.adapter.onTurnError = async (context, error) => {
      console.error('[Teams] Turn error:', error);
      await this._emitError(error);
      try {
        await context.sendActivity('Sorry, something went wrong. Please try again.');
      } catch (e) {
        // Ignore if we can't send error message
      }
    };

    // Create HTTP server
    this.server = restify.createServer();
    this.server.use(restify.plugins.bodyParser());

    this._isInitialized = true;
    console.log('[Teams] Provider initialized');
  }

  /**
   * Parse command from message text
   * @private
   */
  _parseCommand(text) {
    // Remove bot mention
    const cleanText = text.replace(/<at>.*?<\/at>/g, '').trim();
    const prefix = this.config.commandPrefix;

    // Check for commands with various prefixes
    const prefixes = [prefix, 'od', 'opencode'];
    for (const p of prefixes) {
      const match = cleanText.match(new RegExp(`^${p}-(\\w+)(?:\\s+(.*))?$`, 'is'));
      if (match) {
        return {
          isCommand: true,
          command: match[1].toLowerCase(),
          args: (match[2] || '').trim()
        };
      }
    }

    return { isCommand: false, text: cleanText };
  }

  /**
   * Get conversation ID from reference
   * @private
   */
  _getConversationId(conversationRef) {
    return conversationRef?.conversation?.id || conversationRef?.conversation || null;
  }

  /**
   * Bot logic handler
   * @private
   */
  async _botLogic(context) {
    if (context.activity.type === ActivityTypes.Message) {
      const text = context.activity.text || '';
      const parsed = this._parseCommand(text);

      // Store conversation reference for proactive messaging
      const conversationRef = TurnContext.getConversationReference(context.activity);
      const convId = this._getConversationId(conversationRef);
      if (convId) {
        this._conversationReferences.set(convId, conversationRef);
      }

      // Create context
      const ctx = this._createContext({
        channelId: convId,
        userId: context.activity.from?.aadObjectId || context.activity.from?.id,
        userName: context.activity.from?.name,
        messageId: context.activity.id,
        raw: context.activity
      });

      // Store the turn context for sending messages
      this._pendingContexts.set(convId, context);

      // Override reply
      ctx.reply = async (responseText, options = {}) => {
        return this._sendToContext(context, responseText, options);
      };

      if (parsed.isCommand) {
        await this._emitCommand(ctx, parsed.command, parsed.args);
      } else if (parsed.text) {
        await this._emitMessage(ctx, parsed.text);
      }

      // Clean up pending context
      this._pendingContexts.delete(convId);

    } else if (context.activity.type === ActivityTypes.ConversationUpdate) {
      // Welcome new members
      if (context.activity.membersAdded) {
        for (const member of context.activity.membersAdded) {
          if (member.id !== context.activity.recipient.id) {
            const prefix = this.config.commandPrefix;
            await context.sendActivity(
              `Hello! I'm Open Dispatch.\n\n` +
              `I help you control AI coding instances from Teams.\n\n` +
              `**Commands:**\n` +
              `- \`${prefix}-start <name> <path>\` - Start an instance\n` +
              `- \`${prefix}-stop <name>\` - Stop an instance\n` +
              `- \`${prefix}-list\` - List instances\n` +
              `- \`${prefix}-send <name> <message>\` - Send to instance`
            );
          }
        }
      }
    }
  }

  /**
   * Send message using turn context
   * @private
   */
  async _sendToContext(context, text, options = {}) {
    try {
      const chunks = this.chunkText(text);
      let lastActivityId = null;

      for (const chunk of chunks) {
        const activity = await context.sendActivity(chunk);
        lastActivityId = activity?.id;
      }

      return { messageId: lastActivityId };
    } catch (error) {
      console.error('[Teams] Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Start the Teams bot server
   */
  async start() {
    if (!this._isInitialized) {
      await this.initialize();
    }

    // Setup routes
    this.server.post('/api/messages', async (req, res) => {
      await this.adapter.process(req, res, (context) => this._botLogic(context));
    });

    // Health check
    this.server.get('/health', (req, res, next) => {
      res.send(200, { status: 'healthy', provider: 'teams' });
      next();
    });

    // Start server
    return new Promise((resolve) => {
      this.server.listen(this.config.port, () => {
        console.log(`[Teams] Bot server running on port ${this.config.port}`);
        console.log(`[Teams] Messaging endpoint: http://localhost:${this.config.port}/api/messages`);
        resolve();
      });
    });
  }

  /**
   * Stop the Teams bot server
   */
  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          console.log('[Teams] Bot server stopped');
          resolve();
        });
      });
    }
  }

  /**
   * Send a message to a Teams conversation
   */
  async sendMessage(channelId, text, options = {}) {
    // Check if we have an active context for this channel
    const context = this._pendingContexts.get(channelId);
    if (context) {
      return this._sendToContext(context, text, options);
    }

    // Otherwise, try proactive messaging
    const conversationRef = this._conversationReferences.get(channelId);
    if (!conversationRef) {
      throw new Error(`No conversation reference for channel ${channelId}`);
    }

    return new Promise((resolve, reject) => {
      this.adapter.continueConversation(conversationRef, async (turnContext) => {
        try {
          const chunks = this.chunkText(text);
          let lastActivityId = null;

          for (const chunk of chunks) {
            const activity = await turnContext.sendActivity(chunk);
            lastActivityId = activity?.id;
          }

          resolve({ messageId: lastActivityId });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Send an Adaptive Card to a Teams conversation
   */
  async sendCard(channelId, cardData) {
    const card = this._createAdaptiveCard(cardData);

    const context = this._pendingContexts.get(channelId);
    if (context) {
      const activity = await context.sendActivity({ attachments: [card] });
      return { messageId: activity?.id };
    }

    const conversationRef = this._conversationReferences.get(channelId);
    if (!conversationRef) {
      // Fall back to text
      return this.sendMessage(channelId, this._cardToText(cardData));
    }

    return new Promise((resolve, reject) => {
      this.adapter.continueConversation(conversationRef, async (turnContext) => {
        try {
          const activity = await turnContext.sendActivity({ attachments: [card] });
          resolve({ messageId: activity?.id });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Create an Adaptive Card from CardData
   * @private
   */
  _createAdaptiveCard(cardData) {
    const body = [];

    if (cardData.title) {
      body.push({
        type: 'TextBlock',
        text: cardData.title,
        weight: 'Bolder',
        size: 'Medium',
        color: cardData.color === '#ff0000' ? 'Attention' :
               cardData.color === '#00ff00' ? 'Good' :
               cardData.color === '#ff9900' ? 'Warning' : 'Default'
      });
    }

    if (cardData.description) {
      body.push({
        type: 'TextBlock',
        text: cardData.description,
        wrap: true
      });
    }

    if (cardData.fields && cardData.fields.length > 0) {
      body.push({
        type: 'FactSet',
        facts: cardData.fields.map(f => ({
          title: f.name,
          value: f.value
        }))
      });
    }

    if (cardData.footer) {
      body.push({
        type: 'TextBlock',
        text: cardData.footer,
        wrap: true,
        spacing: 'Medium',
        isSubtle: true
      });
    }

    return CardFactory.adaptiveCard({
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body
    });
  }

  /**
   * Send typing indicator
   */
  async sendTypingIndicator(channelId) {
    const context = this._pendingContexts.get(channelId);
    if (context) {
      try {
        await context.sendActivity({ type: ActivityTypes.Typing });
      } catch (error) {
        console.error('[Teams] Failed to send typing indicator:', error);
      }
    }
  }

  /**
   * Delete a message (Teams has limited support for this)
   */
  async deleteMessage(channelId, messageId) {
    // Teams bot messages can only be deleted/updated in certain scenarios
    // This is a best-effort implementation
    const context = this._pendingContexts.get(channelId);
    if (context) {
      try {
        await context.deleteActivity(messageId);
        return true;
      } catch (error) {
        console.error('[Teams] Failed to delete message:', error);
        return false;
      }
    }
    return false;
  }

  /**
   * Edit an existing message
   */
  async editMessage(channelId, messageId, newText) {
    const context = this._pendingContexts.get(channelId);
    if (context) {
      try {
        await context.updateActivity({
          id: messageId,
          type: 'message',
          text: newText
        });
        return true;
      } catch (error) {
        console.error('[Teams] Failed to edit message:', error);
        return false;
      }
    }
    return false;
  }
}

// Register provider
registerProvider('teams', TeamsProvider);

module.exports = { TeamsProvider };

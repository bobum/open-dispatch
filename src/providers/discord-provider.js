/**
 * Discord Chat Provider
 *
 * Implements the ChatProvider interface for Discord using discord.js.
 * Supports both slash commands and message-based interactions.
 */

const { ChatProvider, registerProvider } = require('./chat-provider');

// discord.js is imported dynamically to allow graceful handling if not installed
let Client, GatewayIntentBits, Events, EmbedBuilder, REST, Routes, SlashCommandBuilder;

/**
 * Discord-specific configuration
 * @typedef {Object} DiscordConfig
 * @property {string} token - Discord bot token
 * @property {string} clientId - Discord application client ID
 * @property {string} [guildId] - Optional guild ID for guild-specific commands (faster registration)
 * @property {string} [commandPrefix='od'] - Prefix for text commands (e.g., 'od-start')
 * @property {boolean} [useSlashCommands=true] - Register and use slash commands
 * @property {boolean} [useTextCommands=true] - Also listen for text commands
 */

class DiscordProvider extends ChatProvider {
  /**
   * @param {DiscordConfig} config
   */
  constructor(config) {
    super(config);

    this.client = null;
    this.rest = null;
    this._isInitialized = false;

    // Validate required config
    if (!config.token) {
      throw new Error('Discord provider requires token');
    }
    if (!config.clientId) {
      throw new Error('Discord provider requires clientId');
    }

    // Set defaults
    this.config = {
      commandPrefix: 'od',
      useSlashCommands: true,
      useTextCommands: true,
      ...config
    };
  }

  get name() {
    return 'discord';
  }

  get maxMessageLength() {
    return 2000;
  }

  get supportsCards() {
    return true; // Discord embeds
  }

  get supportsEphemeral() {
    return true; // Slash command responses can be ephemeral
  }

  get supportsThreads() {
    return true;
  }

  /**
   * Initialize Discord client and load discord.js
   */
  async initialize() {
    if (this._isInitialized) return;

    // Dynamic import of discord.js
    try {
      const discordjs = require('discord.js');
      Client = discordjs.Client;
      GatewayIntentBits = discordjs.GatewayIntentBits;
      Events = discordjs.Events;
      EmbedBuilder = discordjs.EmbedBuilder;
      REST = discordjs.REST;
      Routes = discordjs.Routes;
      SlashCommandBuilder = discordjs.SlashCommandBuilder;
    } catch (error) {
      throw new Error(
        'discord.js is not installed. Run: npm install discord.js'
      );
    }

    // Create client with required intents
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // Privileged intent - must enable in Discord Developer Portal
        GatewayIntentBits.DirectMessages
      ]
    });

    // Setup REST client for slash command registration
    this.rest = new REST({ version: '10' }).setToken(this.config.token);

    // Setup event handlers
    this._setupEventHandlers();

    this._isInitialized = true;
    console.log('[Discord] Provider initialized');
  }

  /**
   * Setup Discord event handlers
   * @private
   */
  _setupEventHandlers() {
    // Ready event
    this.client.once(Events.ClientReady, (client) => {
      console.log(`[Discord] Logged in as ${client.user.tag}`);
    });

    // Message event (for text commands and general messages)
    this.client.on(Events.MessageCreate, async (message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      const ctx = this._createContext({
        channelId: message.channelId,
        userId: message.author.id,
        userName: message.author.username,
        messageId: message.id,
        raw: message
      });

      const text = message.content;
      const prefix = this.config.commandPrefix;

      // Check for text commands (e.g., od-start, od-stop)
      if (this.config.useTextCommands && text.startsWith(`${prefix}-`)) {
        const match = text.match(new RegExp(`^${prefix}-(\\w+)(?:\\s+(.*))?$`, 's'));
        if (match) {
          const [, command, args] = match;
          await this._emitCommand(ctx, command.toLowerCase(), (args || '').trim());
          return;
        }
      }

      // Regular message
      await this._emitMessage(ctx, text);
    });

    // Slash command interaction
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const ctx = this._createContext({
        channelId: interaction.channelId,
        userId: interaction.user.id,
        userName: interaction.user.username,
        messageId: null,
        raw: interaction
      });

      // Attach interaction-specific reply methods
      ctx.deferReply = () => interaction.deferReply();
      ctx.editReply = (content) => interaction.editReply(content);
      ctx.followUp = (content) => interaction.followUp(content);
      ctx.isDeferred = false;

      // Override reply for interaction context
      ctx.reply = async (text, options = {}) => {
        if (ctx.isDeferred) {
          return interaction.editReply({ content: text, ephemeral: options.ephemeral });
        }
        return interaction.reply({ content: text, ephemeral: options.ephemeral });
      };

      const command = interaction.commandName.replace(`${this.config.commandPrefix}-`, '');

      // Build args from options
      const args = interaction.options.data
        .map((opt) => opt.value)
        .join(' ');

      await this._emitCommand(ctx, command, args);
    });

    // Error handling
    this.client.on(Events.Error, (error) => {
      this._emitError(error);
    });
  }

  /**
   * Register slash commands with Discord
   * @private
   */
  async _registerSlashCommands() {
    if (!this.config.useSlashCommands) return;

    const prefix = this.config.commandPrefix;

    const commands = [
      new SlashCommandBuilder()
        .setName(`${prefix}-start`)
        .setDescription('Start a new AI coding instance')
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Instance name')
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('path')
            .setDescription('Project directory path')
            .setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName(`${prefix}-stop`)
        .setDescription('Stop a running instance')
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Instance name to stop')
            .setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName(`${prefix}-list`)
        .setDescription('List all running instances'),

      new SlashCommandBuilder()
        .setName(`${prefix}-send`)
        .setDescription('Send a message to a specific instance')
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Instance name')
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName('message')
            .setDescription('Message to send')
            .setRequired(true)
        )
    ];

    const commandData = commands.map((cmd) => cmd.toJSON());

    try {
      if (this.config.guildId) {
        // Guild-specific commands (instant registration, good for development)
        await this.rest.put(
          Routes.applicationGuildCommands(this.config.clientId, this.config.guildId),
          { body: commandData }
        );
        console.log(`[Discord] Registered ${commands.length} guild slash commands`);
      } else {
        // Global commands (can take up to 1 hour to propagate)
        await this.rest.put(
          Routes.applicationCommands(this.config.clientId),
          { body: commandData }
        );
        console.log(`[Discord] Registered ${commands.length} global slash commands`);
      }
    } catch (error) {
      console.error('[Discord] Failed to register slash commands:', error);
      throw error;
    }
  }

  /**
   * Start the Discord bot
   */
  async start() {
    if (!this._isInitialized) {
      await this.initialize();
    }

    // Register slash commands first
    await this._registerSlashCommands();

    // Login to Discord
    await this.client.login(this.config.token);

    console.log('[Discord] Bot started');
  }

  /**
   * Stop the Discord bot
   */
  async stop() {
    if (this.client) {
      await this.client.destroy();
      console.log('[Discord] Bot stopped');
    }
  }

  /**
   * Send a message to a Discord channel
   */
  async sendMessage(channelId, text, options = {}) {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel ${channelId} not found or not text-based`);
      }

      // Handle messages that exceed Discord's limit
      const chunks = this.chunkText(text);
      let lastMessageId = null;

      for (const chunk of chunks) {
        const messageOptions = { content: chunk };

        if (options.replyTo && !lastMessageId) {
          messageOptions.reply = { messageReference: options.replyTo };
        }

        const sent = await channel.send(messageOptions);
        lastMessageId = sent.id;
      }

      return { messageId: lastMessageId };
    } catch (error) {
      console.error('[Discord] Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Send a rich embed to a Discord channel
   */
  async sendCard(channelId, cardData) {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel ${channelId} not found or not text-based`);
      }

      const embed = new EmbedBuilder();

      if (cardData.title) {
        embed.setTitle(cardData.title);
      }
      if (cardData.description) {
        embed.setDescription(cardData.description);
      }
      if (cardData.color) {
        embed.setColor(cardData.color);
      }
      if (cardData.fields && cardData.fields.length > 0) {
        embed.addFields(
          cardData.fields.map((f) => ({
            name: f.name,
            value: f.value,
            inline: f.inline || false
          }))
        );
      }
      if (cardData.footer) {
        embed.setFooter({ text: cardData.footer });
      }

      const sent = await channel.send({ embeds: [embed] });
      return { messageId: sent.id };
    } catch (error) {
      console.error('[Discord] Failed to send card:', error);
      throw error;
    }
  }

  /**
   * Send typing indicator
   */
  async sendTypingIndicator(channelId) {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (channel && channel.isTextBased()) {
        await channel.sendTyping();
      }
    } catch (error) {
      console.error('[Discord] Failed to send typing indicator:', error);
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(channelId, messageId) {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        return false;
      }

      const message = await channel.messages.fetch(messageId);
      await message.delete();
      return true;
    } catch (error) {
      console.error('[Discord] Failed to delete message:', error);
      return false;
    }
  }

  /**
   * Edit an existing message
   */
  async editMessage(channelId, messageId, newText) {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        return false;
      }

      const message = await channel.messages.fetch(messageId);
      await message.edit(newText);
      return true;
    } catch (error) {
      console.error('[Discord] Failed to edit message:', error);
      return false;
    }
  }

  /**
   * Create a thread for a conversation
   * @param {string} channelId - Parent channel
   * @param {string} name - Thread name
   * @param {string} [messageId] - Optional message to create thread from
   * @returns {Promise<{threadId: string}>}
   */
  async createThread(channelId, name, messageId = null) {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !channel.isTextBased()) {
        throw new Error(`Channel ${channelId} not found or not text-based`);
      }

      let thread;
      if (messageId) {
        const message = await channel.messages.fetch(messageId);
        thread = await message.startThread({ name });
      } else {
        thread = await channel.threads.create({ name, autoArchiveDuration: 1440 });
      }

      return { threadId: thread.id };
    } catch (error) {
      console.error('[Discord] Failed to create thread:', error);
      throw error;
    }
  }
}

// Register provider
registerProvider('discord', DiscordProvider);

module.exports = { DiscordProvider };

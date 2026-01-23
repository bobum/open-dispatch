/**
 * Bot Engine
 *
 * Platform-agnostic bot logic that works with any ChatProvider and AI backend.
 * Handles command parsing, instance routing, and response formatting.
 */

/**
 * @typedef {Object} BotEngineOptions
 * @property {import('./providers/chat-provider').ChatProvider} chatProvider - Chat platform provider
 * @property {Object} aiBackend - AI instance manager (from claude-core or opencode-core)
 * @property {string} [commandPrefix='od'] - Command prefix for text commands
 * @property {string} [aiName='AI'] - Display name for the AI (e.g., 'Claude', 'OpenCode')
 * @property {boolean} [showThinking=true] - Show "Thinking..." indicator
 * @property {boolean} [streamResponses=true] - Use streaming if available
 */

/**
 * Create a bot engine instance
 * @param {BotEngineOptions} options
 * @returns {Object} Bot engine with start/stop methods
 */
function createBotEngine(options) {
  const {
    chatProvider,
    aiBackend,
    commandPrefix = 'od',
    aiName = 'AI',
    showThinking = true,
    streamResponses = true
  } = options;

  if (!chatProvider) {
    throw new Error('chatProvider is required');
  }
  if (!aiBackend) {
    throw new Error('aiBackend is required');
  }

  // ============================================
  // COMMAND HANDLERS
  // ============================================

  /**
   * Handle the 'start' command
   */
  async function handleStart(ctx, args) {
    const parts = args.trim().split(/\s+/);

    if (parts.length < 2) {
      await ctx.reply(
        `Usage: \`${commandPrefix}-start <instance-name> <project-directory>\``
      );
      return;
    }

    const [instanceId, ...pathParts] = parts;
    const projectDir = pathParts.join(' ');

    const result = aiBackend.startInstance(instanceId, projectDir, ctx.channelId);

    if (result.success) {
      if (chatProvider.supportsCards) {
        await chatProvider.sendCard(ctx.channelId, {
          title: `${aiName} Instance Started`,
          color: '#00ff00',
          fields: [
            { name: 'Instance', value: instanceId, inline: true },
            { name: 'Project', value: projectDir, inline: true },
            { name: 'Session', value: result.sessionId.substring(0, 8) + '...', inline: true }
          ],
          footer: `Messages in this channel will be sent to ${aiName}.`
        });
      } else {
        await ctx.reply(
          `Started instance **${instanceId}** in \`${projectDir}\`\n` +
          `Session: \`${result.sessionId}\`\n\n` +
          `Messages in this channel will be sent to ${aiName}.`
        );
      }
    } else {
      if (chatProvider.supportsCards) {
        await chatProvider.sendCard(ctx.channelId, {
          title: 'Failed to Start',
          color: '#ff0000',
          description: result.error
        });
      } else {
        await ctx.reply(`Failed to start: ${result.error}`);
      }
    }
  }

  /**
   * Handle the 'stop' command
   */
  async function handleStop(ctx, args) {
    const instanceId = args.trim();

    if (!instanceId) {
      await ctx.reply(`Usage: \`${commandPrefix}-stop <instance-name>\``);
      return;
    }

    const result = aiBackend.stopInstance(instanceId);

    if (result.success) {
      if (chatProvider.supportsCards) {
        await chatProvider.sendCard(ctx.channelId, {
          title: `${aiName} Instance Stopped`,
          color: '#ff9900',
          description: `Instance "${instanceId}" has been stopped.`
        });
      } else {
        await ctx.reply(`Stopped instance **${instanceId}**`);
      }
    } else {
      if (chatProvider.supportsCards) {
        await chatProvider.sendCard(ctx.channelId, {
          title: 'Failed to Stop',
          color: '#ff0000',
          description: result.error
        });
      } else {
        await ctx.reply(`Failed to stop: ${result.error}`);
      }
    }
  }

  /**
   * Handle the 'list' command
   */
  async function handleList(ctx) {
    const instances = aiBackend.listInstances();

    if (instances.length === 0) {
      if (chatProvider.supportsCards) {
        await chatProvider.sendCard(ctx.channelId, {
          title: 'No Running Instances',
          description: `Use \`${commandPrefix}-start <name> <project-path>\` to start a new instance.`
        });
      } else {
        await ctx.reply('No instances running.');
      }
      return;
    }

    if (chatProvider.supportsCards) {
      const fields = instances.map((inst) => {
        const uptime = Math.round((Date.now() - inst.startedAt.getTime()) / 1000 / 60);
        return {
          name: inst.instanceId,
          value: `${inst.projectDir}\n${inst.messageCount} messages | ${uptime}m uptime`,
          inline: false
        };
      });

      await chatProvider.sendCard(ctx.channelId, {
        title: `Running ${aiName} Instances`,
        color: '#0099ff',
        fields
      });
    } else {
      const lines = instances.map((inst) => {
        const uptime = Math.round((Date.now() - inst.startedAt.getTime()) / 1000 / 60);
        return `- **${inst.instanceId}** - \`${inst.projectDir}\` (${inst.messageCount} messages, ${uptime}m uptime)`;
      });

      await ctx.reply(`**Running instances:**\n${lines.join('\n')}`);
    }
  }

  /**
   * Handle the 'send' command
   */
  async function handleSend(ctx, args) {
    const match = args.match(/^(\S+)\s+(.+)$/s);

    if (!match) {
      await ctx.reply(
        `Usage: \`${commandPrefix}-send <instance-name> <message>\``
      );
      return;
    }

    const [, instanceId, message] = match;

    await sendMessageToInstance(ctx, instanceId, message);
  }

  /**
   * Send a message to an AI instance and handle the response
   */
  async function sendMessageToInstance(ctx, instanceId, message) {
    const instance = aiBackend.getInstance(instanceId);

    if (!instance) {
      if (chatProvider.supportsCards) {
        await chatProvider.sendCard(ctx.channelId, {
          title: 'Instance Not Found',
          color: '#ff0000',
          description: `Instance "${instanceId}" is not running.`
        });
      } else {
        await ctx.reply(`Instance "${instanceId}" not found.`);
      }
      return;
    }

    // Show typing indicator
    await chatProvider.sendTypingIndicator(ctx.channelId);

    // Optional "Thinking..." message
    let thinkingMessageId = null;
    let thinkingDeleted = false;
    if (showThinking) {
      try {
        const thinkingResult = await chatProvider.sendMessage(
          ctx.channelId,
          '_Thinking..._'
        );
        thinkingMessageId = thinkingResult.messageId;
      } catch (e) {
        // Ignore if we can't send thinking message
      }
    }

    // Helper to delete thinking message (only once)
    const deleteThinkingMessage = async () => {
      if (thinkingMessageId && !thinkingDeleted) {
        thinkingDeleted = true;
        try {
          await chatProvider.deleteMessage(ctx.channelId, thinkingMessageId);
        } catch (e) {
          // Ignore if we can't delete
        }
      }
    };

    // Track what we've streamed to avoid duplicates
    const streamedTexts = new Set();
    let didStream = false;

    // Prepare streaming callback - sends messages to chat in real-time
    const onMessage = streamResponses
      ? async (text) => {
          // Delete thinking message on first real response
          await deleteThinkingMessage();

          // Avoid sending duplicates
          if (streamedTexts.has(text)) {
            return;
          }
          streamedTexts.add(text);
          didStream = true;

          // Send to chat immediately
          try {
            await chatProvider.sendLongMessage(ctx.channelId, text);
          } catch (e) {
            console.error('[BotEngine] Failed to stream message:', e);
          }
        }
      : null;

    // Send to AI backend
    const result = await aiBackend.sendToInstance(instanceId, message, {
      onMessage
    });

    // Delete thinking message if we haven't already
    await deleteThinkingMessage();

    // Send response (only if we didn't stream, or streaming failed)
    if (result.success) {
      if (!didStream && result.responses && result.responses.length > 0) {
        for (const response of result.responses) {
          await chatProvider.sendLongMessage(ctx.channelId, response);
        }
      }
    } else {
      if (chatProvider.supportsCards) {
        await chatProvider.sendCard(ctx.channelId, {
          title: 'Error',
          color: '#ff0000',
          description: result.error
        });
      } else {
        await ctx.reply(`_Error: ${result.error}_`);
      }
    }
  }

  // ============================================
  // EVENT WIRING
  // ============================================

  /**
   * Handle incoming commands
   */
  chatProvider.onCommand(async (ctx, command, args) => {
    console.log(`[BotEngine] Command: ${command}, Args: ${args}`);

    switch (command.toLowerCase()) {
      case 'start':
        await handleStart(ctx, args);
        break;
      case 'stop':
        await handleStop(ctx, args);
        break;
      case 'list':
        await handleList(ctx);
        break;
      case 'send':
        await handleSend(ctx, args);
        break;
      default:
        await ctx.reply(
          `Unknown command: ${command}\n\n` +
          `**Available commands:**\n` +
          `- \`${commandPrefix}-start <name> <path>\` - Start an instance\n` +
          `- \`${commandPrefix}-stop <name>\` - Stop an instance\n` +
          `- \`${commandPrefix}-list\` - List instances\n` +
          `- \`${commandPrefix}-send <name> <message>\` - Send to instance`
        );
    }
  });

  /**
   * Handle incoming messages (route to active instance)
   */
  chatProvider.onMessage(async (ctx, text) => {
    // Find instance by channel
    const found = aiBackend.getInstanceByChannel(ctx.channelId);

    if (found) {
      console.log(`[BotEngine] Routing message to instance: ${found.instanceId}`);
      await sendMessageToInstance(ctx, found.instanceId, text);
    }
    // If no instance, ignore the message (don't spam help in every channel)
  });

  /**
   * Handle errors
   */
  chatProvider.onError(async (error, ctx) => {
    console.error('[BotEngine] Error:', error);

    if (ctx) {
      try {
        if (chatProvider.supportsCards) {
          await chatProvider.sendCard(ctx.channelId, {
            title: 'Error',
            color: '#ff0000',
            description: 'An unexpected error occurred. Please try again.'
          });
        } else {
          await ctx.reply('_An unexpected error occurred. Please try again._');
        }
      } catch (e) {
        // Ignore if we can't send error message
      }
    }
  });

  // ============================================
  // PUBLIC API
  // ============================================

  return {
    /**
     * Start the bot
     */
    async start() {
      await chatProvider.initialize();
      await chatProvider.start();
      console.log(`[BotEngine] Started with ${chatProvider.name} provider and ${aiName} backend`);
    },

    /**
     * Stop the bot
     */
    async stop() {
      await chatProvider.stop();
      console.log('[BotEngine] Stopped');
    },

    /**
     * Get the chat provider
     */
    get chatProvider() {
      return chatProvider;
    },

    /**
     * Get the AI backend
     */
    get aiBackend() {
      return aiBackend;
    },

    /**
     * Get list of running instances
     */
    listInstances() {
      return aiBackend.listInstances();
    }
  };
}

module.exports = { createBotEngine };

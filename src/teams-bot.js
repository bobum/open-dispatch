require('dotenv').config();

const { BotFrameworkAdapter, ActivityTypes, CardFactory, TurnContext } = require('botbuilder');
const restify = require('restify');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const readline = require('readline');

// Create HTTP server
const server = restify.createServer();
server.use(restify.plugins.bodyParser());

const PORT = process.env.PORT || 3978;

// Create Bot Framework adapter
const adapter = new BotFrameworkAdapter({
  appId: process.env.MICROSOFT_APP_ID,
  appPassword: process.env.MICROSOFT_APP_PASSWORD,
});

// Error handling
adapter.onTurnError = async (context, error) => {
  console.error(`[Bot Error] ${error}`);
  await context.sendActivity('Sorry, something went wrong. Please try again.');
};

// Track instances: instanceId → { sessionId, conversationRef, projectDir, messageCount }
const instances = new Map();

// ============================================
// ADAPTIVE CARD TEMPLATES
// ============================================

function createInstanceStartedCard(instanceId, projectDir, sessionId) {
  return CardFactory.adaptiveCard({
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: '✅ Claude Instance Started',
        weight: 'Bolder',
        size: 'Medium',
        color: 'Good'
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Instance', value: instanceId },
          { title: 'Project', value: projectDir },
          { title: 'Session', value: sessionId.substring(0, 8) + '...' }
        ]
      },
      {
        type: 'TextBlock',
        text: 'Messages in this conversation will now be sent to Claude.',
        wrap: true,
        spacing: 'Medium'
      }
    ]
  });
}

function createInstanceStoppedCard(instanceId) {
  return CardFactory.adaptiveCard({
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: '🛑 Claude Instance Stopped',
        weight: 'Bolder',
        size: 'Medium',
        color: 'Attention'
      },
      {
        type: 'TextBlock',
        text: `Instance "${instanceId}" has been stopped.`,
        wrap: true
      }
    ]
  });
}

function createInstanceListCard(instancesData) {
  if (instancesData.length === 0) {
    return CardFactory.adaptiveCard({
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: '📋 No Running Instances',
          weight: 'Bolder',
          size: 'Medium'
        },
        {
          type: 'TextBlock',
          text: 'Use `claude-start <name> <project-path>` to start a new instance.',
          wrap: true
        }
      ]
    });
  }

  const items = instancesData.map(({ instanceId, instance }) => {
    const uptime = Math.round((Date.now() - instance.startedAt.getTime()) / 1000 / 60);
    return {
      type: 'Container',
      items: [
        {
          type: 'TextBlock',
          text: `**${instanceId}**`,
          weight: 'Bolder'
        },
        {
          type: 'FactSet',
          facts: [
            { title: 'Project', value: instance.projectDir },
            { title: 'Messages', value: String(instance.messageCount) },
            { title: 'Uptime', value: `${uptime} minutes` }
          ]
        }
      ],
      separator: true,
      spacing: 'Medium'
    };
  });

  return CardFactory.adaptiveCard({
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: '📋 Running Claude Instances',
        weight: 'Bolder',
        size: 'Medium'
      },
      ...items
    ]
  });
}

function createErrorCard(title, message) {
  return CardFactory.adaptiveCard({
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: `❌ ${title}`,
        weight: 'Bolder',
        size: 'Medium',
        color: 'Attention'
      },
      {
        type: 'TextBlock',
        text: message,
        wrap: true
      }
    ]
  });
}

function createThinkingCard() {
  return CardFactory.adaptiveCard({
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: '🤔 Thinking...',
        weight: 'Bolder',
        isSubtle: true
      }
    ]
  });
}

// ============================================
// INSTANCE MANAGEMENT (same as Slack version)
// ============================================

/**
 * Start a new Claude Code instance
 */
function startInstance(instanceId, projectDir, conversationRef) {
  if (instances.has(instanceId)) {
    return { success: false, error: `Instance "${instanceId}" already running` };
  }

  const sessionId = randomUUID();

  instances.set(instanceId, {
    sessionId,
    conversationRef,
    projectDir,
    messageCount: 0,
    startedAt: new Date()
  });

  console.log(`[${instanceId}] created session ${sessionId} in ${projectDir}`);
  return { success: true, sessionId };
}

/**
 * Send a message to a Claude instance
 */
async function sendToInstance(instanceId, message) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return { success: false, error: `Instance "${instanceId}" not found` };
  }

  const isFirstMessage = instance.messageCount === 0;
  instance.messageCount++;

  const args = [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose'
  ];

  if (isFirstMessage) {
    args.push('--session-id', instance.sessionId);
  } else {
    args.push('--resume', instance.sessionId);
  }

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd: instance.projectDir,
      shell: true,
      env: { ...process.env }
    });

    const rl = readline.createInterface({ input: proc.stdout });
    const responses = [];

    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'assistant' && event.message?.content) {
          const text = extractText(event.message.content);
          if (text) {
            responses.push(text);
          }
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!msg.includes('Error') || msg.includes('write')) {
        return;
      }
      console.error(`[${instanceId}] stderr: ${msg}`);
    });

    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[${instanceId}] exited with code ${code}`);
      }
      resolve({ success: true, responses });
    });

    proc.on('error', (err) => {
      console.error(`[${instanceId}] failed to spawn:`, err);
      resolve({ success: false, error: err.message });
    });

    const input = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: message
      }
    });

    proc.stdin.write(input + '\n');
    proc.stdin.end();
  });
}

/**
 * Extract text content from Claude's message content blocks
 */
function extractText(content) {
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return typeof content === 'string' ? content : null;
}

/**
 * Stop a Claude instance
 */
function stopInstance(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return { success: false, error: `Instance "${instanceId}" not found` };
  }

  instances.delete(instanceId);
  console.log(`[${instanceId}] stopped`);
  return { success: true };
}

/**
 * Get conversation reference ID for lookups
 */
function getConversationId(conversationRef) {
  return conversationRef.conversation?.id || conversationRef.conversation;
}

/**
 * Find instance by conversation reference
 */
function getInstanceByConversation(conversationRef) {
  const convId = getConversationId(conversationRef);
  for (const [instanceId, instance] of instances) {
    if (getConversationId(instance.conversationRef) === convId) {
      return { instanceId, instance };
    }
  }
  return null;
}

// ============================================
// MESSAGE HANDLING
// ============================================

/**
 * Post response to Teams (handles long messages by chunking)
 */
async function postToTeams(context, text) {
  const MAX_LENGTH = 25000; // Teams limit is ~28KB, leave buffer

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let breakPoint = remaining.lastIndexOf('\n', MAX_LENGTH);
    if (breakPoint === -1 || breakPoint < MAX_LENGTH / 2) {
      breakPoint = remaining.lastIndexOf(' ', MAX_LENGTH);
    }
    if (breakPoint === -1 || breakPoint < MAX_LENGTH / 2) {
      breakPoint = MAX_LENGTH;
    }
    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trim();
  }

  for (const chunk of chunks) {
    await context.sendActivity(chunk);
  }
}

/**
 * Parse command from message text
 */
function parseCommand(text) {
  // Remove bot mention (Teams includes @mention in message)
  const cleanText = text.replace(/<at>.*?<\/at>/g, '').trim();

  // Check for commands
  const commandMatch = cleanText.match(/^(claude-start|claude-stop|claude-list|claude-send)\s*(.*)?$/i);
  if (commandMatch) {
    return {
      command: commandMatch[1].toLowerCase(),
      args: (commandMatch[2] || '').trim()
    };
  }

  return { command: null, text: cleanText };
}

/**
 * Main bot logic
 */
async function botLogic(context) {
  if (context.activity.type === ActivityTypes.Message) {
    const text = context.activity.text || '';
    const { command, args, text: messageText } = parseCommand(text);

    console.log(`[DEBUG] Received message: ${text.substring(0, 50)}`);
    console.log(`[DEBUG] Parsed command: ${command}, args: ${args}`);

    // Handle commands
    if (command) {
      switch (command) {
        case 'claude-start': {
          const parts = args.split(/\s+/);
          if (parts.length < 2) {
            await context.sendActivity({
              attachments: [createErrorCard('Invalid Usage', 'Usage: `claude-start <instance-name> <project-directory>`')]
            });
            return;
          }

          const [instanceId, ...pathParts] = parts;
          const projectDir = pathParts.join(' ');
          const conversationRef = TurnContext.getConversationReference(context.activity);

          const result = startInstance(instanceId, projectDir, conversationRef);

          if (result.success) {
            await context.sendActivity({
              attachments: [createInstanceStartedCard(instanceId, projectDir, result.sessionId)]
            });
          } else {
            await context.sendActivity({
              attachments: [createErrorCard('Failed to Start', result.error)]
            });
          }
          break;
        }

        case 'claude-stop': {
          const instanceId = args;
          if (!instanceId) {
            await context.sendActivity({
              attachments: [createErrorCard('Invalid Usage', 'Usage: `claude-stop <instance-name>`')]
            });
            return;
          }

          const result = stopInstance(instanceId);

          if (result.success) {
            await context.sendActivity({
              attachments: [createInstanceStoppedCard(instanceId)]
            });
          } else {
            await context.sendActivity({
              attachments: [createErrorCard('Failed to Stop', result.error)]
            });
          }
          break;
        }

        case 'claude-list': {
          const instancesData = Array.from(instances.entries()).map(([instanceId, instance]) => ({
            instanceId,
            instance
          }));

          await context.sendActivity({
            attachments: [createInstanceListCard(instancesData)]
          });
          break;
        }

        case 'claude-send': {
          const match = args.match(/^(\S+)\s+(.+)$/s);
          if (!match) {
            await context.sendActivity({
              attachments: [createErrorCard('Invalid Usage', 'Usage: `claude-send <instance-name> <message>`')]
            });
            return;
          }

          const [, instanceId, message] = match;

          // Send typing indicator
          await context.sendActivity({ type: ActivityTypes.Typing });

          const result = await sendToInstance(instanceId, message);

          if (result.success && result.responses.length > 0) {
            for (const response of result.responses) {
              await postToTeams(context, response);
            }
          } else if (!result.success) {
            await context.sendActivity({
              attachments: [createErrorCard('Failed to Send', result.error)]
            });
          }
          break;
        }
      }
      return;
    }

    // No command - check if this conversation has an active instance
    const conversationRef = TurnContext.getConversationReference(context.activity);
    const found = getInstanceByConversation(conversationRef);

    if (found && messageText) {
      console.log(`[DEBUG] Found instance: ${found.instanceId}`);

      // Send typing indicator
      await context.sendActivity({ type: ActivityTypes.Typing });

      const result = await sendToInstance(found.instanceId, messageText);

      if (result.success && result.responses.length > 0) {
        for (const response of result.responses) {
          await postToTeams(context, response);
        }
      } else if (!result.success) {
        await context.sendActivity({
          attachments: [createErrorCard('Error', result.error)]
        });
      }
    } else if (!found && messageText) {
      // No active instance, provide help
      await context.sendActivity(
        'No Claude instance is running in this conversation.\n\n' +
        '**Commands:**\n' +
        '- `claude-start <name> <project-path>` - Start a new instance\n' +
        '- `claude-stop <name>` - Stop an instance\n' +
        '- `claude-list` - List running instances\n' +
        '- `claude-send <name> <message>` - Send to a specific instance'
      );
    }
  } else if (context.activity.type === ActivityTypes.ConversationUpdate) {
    // Welcome new members
    if (context.activity.membersAdded) {
      for (const member of context.activity.membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            '👋 Hello! I\'m Claude Dispatch.\n\n' +
            'I help you control Claude Code instances from Teams.\n\n' +
            '**Commands:**\n' +
            '- `claude-start <name> <project-path>` - Start a new instance\n' +
            '- `claude-stop <name>` - Stop an instance\n' +
            '- `claude-list` - List running instances\n' +
            '- `claude-send <name> <message>` - Send to a specific instance'
          );
        }
      }
    }
  }
}

// ============================================
// SERVER SETUP
// ============================================

// Listen for incoming requests
server.post('/api/messages', async (req, res) => {
  await adapter.process(req, res, botLogic);
});

// Health check endpoint
server.get('/health', (req, res, next) => {
  res.send(200, { status: 'healthy', instances: instances.size });
  next();
});

// Start server
server.listen(PORT, () => {
  console.log(`Claude Dispatch (Teams) is running on port ${PORT}`);
  console.log(`Messaging endpoint: http://localhost:${PORT}/api/messages`);
  console.log('');
  console.log('For local development with ngrok:');
  console.log(`  ngrok http ${PORT}`);
  console.log('  Then update your Azure Bot messaging endpoint');
});

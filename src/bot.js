const { App } = require('@slack/bolt');
const { spawn } = require('child_process');
const readline = require('readline');

// Initialize Slack app with Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Track running instances: instanceId → { process, channel, projectDir }
const instances = new Map();

/**
 * Start a new Claude Code instance
 */
function startInstance(instanceId, projectDir, slackChannel) {
  if (instances.has(instanceId)) {
    return { success: false, error: `Instance "${instanceId}" already running` };
  }

  const proc = spawn('claude', [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json'
  ], {
    cwd: projectDir,
    shell: true,
    env: { ...process.env }
  });

  const rl = readline.createInterface({ input: proc.stdout });

  rl.on('line', async (line) => {
    try {
      const event = JSON.parse(line);
      
      // Only forward assistant text messages to Slack
      if (event.type === 'assistant' && event.message?.content) {
        const text = extractText(event.message.content);
        if (text) {
          await postToSlack(slackChannel, text);
        }
      }
    } catch (e) {
      // Ignore JSON parse errors (some lines may not be JSON)
    }
  });

  proc.stderr.on('data', (data) => {
    console.error(`[${instanceId}] stderr: ${data}`);
  });

  proc.on('close', (code) => {
    console.log(`[${instanceId}] exited with code ${code}`);
    instances.delete(instanceId);
    postToSlack(slackChannel, `_Instance "${instanceId}" has stopped (exit code: ${code})_`);
  });

  proc.on('error', (err) => {
    console.error(`[${instanceId}] failed to start:`, err);
    instances.delete(instanceId);
  });

  instances.set(instanceId, { 
    process: proc, 
    channel: slackChannel, 
    projectDir,
    startedAt: new Date()
  });

  console.log(`[${instanceId}] started in ${projectDir}`);
  return { success: true };
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
 * Send a message to a Claude instance
 */
function sendToInstance(instanceId, message) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return { success: false, error: `Instance "${instanceId}" not found` };
  }
  
  if (!instance.process.stdin.writable) {
    return { success: false, error: `Instance "${instanceId}" stdin not writable` };
  }

  instance.process.stdin.write(message + '\n');
  return { success: true };
}

/**
 * Stop a Claude instance
 */
function stopInstance(instanceId) {
  const instance = instances.get(instanceId);
  if (!instance) {
    return { success: false, error: `Instance "${instanceId}" not found` };
  }

  instance.process.kill();
  instances.delete(instanceId);
  return { success: true };
}

/**
 * Post a message to Slack
 */
async function postToSlack(channel, text) {
  try {
    await app.client.chat.postMessage({
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false
    });
  } catch (err) {
    console.error('Failed to post to Slack:', err);
  }
}

/**
 * Find instance by Slack channel
 */
function getInstanceByChannel(channelId) {
  for (const [instanceId, instance] of instances) {
    if (instance.channel === channelId) {
      return { instanceId, instance };
    }
  }
  return null;
}

// Listen to messages in channels where an instance is running
app.message(async ({ message, say }) => {
  // Ignore bot messages and message edits
  if (message.subtype || message.bot_id) return;

  const found = getInstanceByChannel(message.channel);
  if (found) {
    const result = sendToInstance(found.instanceId, message.text);
    if (!result.success) {
      await say(`_Error: ${result.error}_`);
    }
  }
});

// Slash command: /claude-start <instanceId> <projectDir>
app.command('/claude-start', async ({ command, ack, respond }) => {
  await ack();
  
  const parts = command.text.trim().split(/\s+/);
  if (parts.length < 2) {
    await respond('Usage: `/claude-start <instance-name> <project-directory>`');
    return;
  }

  const [instanceId, ...pathParts] = parts;
  const projectDir = pathParts.join(' '); // Handle paths with spaces

  const result = startInstance(instanceId, projectDir, command.channel_id);
  
  if (result.success) {
    await respond(`Started instance *${instanceId}* in \`${projectDir}\`\n\nMessages in this channel will be sent to Claude.`);
  } else {
    await respond(`Failed to start: ${result.error}`);
  }
});

// Slash command: /claude-stop <instanceId>
app.command('/claude-stop', async ({ command, ack, respond }) => {
  await ack();
  
  const instanceId = command.text.trim();
  if (!instanceId) {
    await respond('Usage: `/claude-stop <instance-name>`');
    return;
  }

  const result = stopInstance(instanceId);
  
  if (result.success) {
    await respond(`Stopped instance *${instanceId}*`);
  } else {
    await respond(`Failed to stop: ${result.error}`);
  }
});

// Slash command: /claude-list
app.command('/claude-list', async ({ ack, respond }) => {
  await ack();
  
  if (instances.size === 0) {
    await respond('No instances running.');
    return;
  }

  const lines = [];
  for (const [instanceId, instance] of instances) {
    const uptime = Math.round((Date.now() - instance.startedAt.getTime()) / 1000 / 60);
    lines.push(`• *${instanceId}* — \`${instance.projectDir}\` (${uptime}m uptime)`);
  }
  
  await respond(`*Running instances:*\n${lines.join('\n')}`);
});

// Slash command: /claude-send <instanceId> <message>
app.command('/claude-send', async ({ command, ack, respond }) => {
  await ack();
  
  const match = command.text.match(/^(\S+)\s+(.+)$/s);
  if (!match) {
    await respond('Usage: `/claude-send <instance-name> <message>`');
    return;
  }

  const [, instanceId, message] = match;
  const result = sendToInstance(instanceId, message);
  
  if (result.success) {
    await respond(`Message sent to *${instanceId}*`);
  } else {
    await respond(`Failed: ${result.error}`);
  }
});

// Start the app
(async () => {
  await app.start();
  console.log('⚡ Claude Dispatch is running');
  console.log('Waiting for Slack commands...');
})();

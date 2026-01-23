# Discord Setup Guide

This guide walks you through setting up Open Dispatch for Discord.

## Prerequisites

- Node.js 18+ installed
- Claude Code CLI or OpenCode CLI installed and working
- A Discord account with permissions to create bots

## Step 1: Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"**
3. Enter a name (e.g., "Open Dispatch" or "Claude Bot")
4. Accept the terms and click **"Create"**

## Step 2: Configure the Bot

1. In your application, go to the **"Bot"** section in the left sidebar
2. Click **"Add Bot"** and confirm
3. Under the bot's username, click **"Reset Token"** to generate a new token
4. **Copy the token** - you'll need this for `DISCORD_BOT_TOKEN`

### Important Bot Settings

Enable these settings under the Bot section:

- **PUBLIC BOT**: Toggle OFF if you only want to add it to your own servers
- **MESSAGE CONTENT INTENT**: Toggle ON (required for reading message content)

> **Note**: The MESSAGE CONTENT INTENT is a privileged intent. For bots in over 100 servers, you'll need to apply for verification.

## Step 3: Get Your Client ID

1. Go to the **"OAuth2"** section in the left sidebar
2. Copy the **"CLIENT ID"** - you'll need this for `DISCORD_CLIENT_ID`

## Step 4: Invite the Bot to Your Server

1. Go to **"OAuth2" → "URL Generator"**
2. Under **"Scopes"**, select:
   - `bot`
   - `applications.commands`
3. Under **"Bot Permissions"**, select:
   - `Send Messages`
   - `Read Message History`
   - `Use Slash Commands`
   - `Embed Links`
   - `Manage Messages` (optional, for deleting "Thinking..." messages)
4. Copy the generated URL at the bottom
5. Open the URL in your browser and select the server to add the bot to

## Step 5: Get Your Guild ID (Optional, Recommended for Development)

For faster slash command registration during development:

1. Enable Developer Mode in Discord:
   - User Settings → Advanced → Developer Mode → ON
2. Right-click on your server name and click **"Copy Server ID"**
3. This is your `DISCORD_GUILD_ID`

> **Why use Guild ID?** Slash commands registered to a specific guild are available instantly. Global commands can take up to 1 hour to propagate.

## Step 6: Configure Environment Variables

Create or update your `.env` file:

```env
# Discord Configuration
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_CLIENT_ID=your-client-id-here
DISCORD_GUILD_ID=your-guild-id-here  # Optional, but recommended for dev

# For OpenCode backend (optional)
# OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
```

## Step 7: Install Dependencies

```bash
npm install
```

## Step 8: Start the Bot

For Claude Code backend:
```bash
npm run start:discord
```

For OpenCode backend:
```bash
npm run start:discord:opencode
```

## Usage

### Slash Commands

| Command | Description |
|---------|-------------|
| `/od-start <name> <path>` | Start a new AI coding instance |
| `/od-stop <name>` | Stop a running instance |
| `/od-list` | List all running instances |
| `/od-send <name> <message>` | Send a message to a specific instance |

### Text Commands

You can also use text commands (prefix: `od-`):

```
od-start myproject /home/user/projects/myproject
od-stop myproject
od-list
od-send myproject What files are in this project?
```

### Channel-Based Messaging

Once an instance is started in a channel, all messages in that channel (not from bots) are automatically sent to the AI instance. No prefix needed!

## Troubleshooting

### "Missing Access" Error

Make sure the bot has been invited with the correct permissions. Re-generate the OAuth2 URL with all required permissions.

### Slash Commands Not Appearing

- If using `DISCORD_GUILD_ID`: Commands should appear instantly. Try restarting the bot.
- If not using `DISCORD_GUILD_ID`: Global commands can take up to 1 hour to propagate.
- Make sure you selected `applications.commands` scope when inviting the bot.

### "Missing Intent" Error

Enable the **MESSAGE CONTENT INTENT** in the Bot settings of the Discord Developer Portal.

### Bot is Online but Not Responding

1. Check that you have the correct `DISCORD_BOT_TOKEN`
2. Check the console for error messages
3. Make sure Claude Code or OpenCode CLI is installed and working
4. Try running the CLI manually to verify it works: `claude --help` or `opencode --help`

## Architecture

```
Discord Server
     │
     ▼
discord-bot.js / discord-opencode-bot.js
     │
     ├── DiscordProvider (src/providers/discord-provider.js)
     │      └── Handles Discord API via discord.js
     │
     ├── BotEngine (src/bot-engine.js)
     │      └── Platform-agnostic command handling
     │
     └── AI Backend (claude-core.js / opencode-core.js)
            └── Spawns CLI processes, manages sessions
```

## Development Mode

For development with auto-reload:

```bash
npm run dev:discord
# or
npm run dev:discord:opencode
```

# Microsoft Teams Setup Guide for Claude Dispatch

This guide walks you through setting up Claude Dispatch to work with Microsoft Teams using the **Teams Developer Portal** (dev.teams.microsoft.com) instead of the Azure Portal.

## Overview

Claude Dispatch for Teams allows you to control Claude Code or OpenCode instances directly from Microsoft Teams channels. This guide uses the Teams Developer Portal for a streamlined setup experience.

## Prerequisites

- Node.js 18+ installed
- Microsoft 365 account with Teams access
- Access to Teams Developer Portal (dev.teams.microsoft.com)
- Claude Code CLI or OpenCode CLI installed and authenticated on the machine running the bot

> **Note**: No Azure subscription required for basic setup! The Teams Developer Portal handles bot registration.

## Architecture

```
Teams User → Microsoft Teams → Bot Framework Service → Your Bot Server → Claude/OpenCode CLI
                                       ↓
                               Bot Framework SDK
```

---

## Step 1: Create Bot in Teams Developer Portal

1. Go to [Teams Developer Portal](https://dev.teams.microsoft.com)
2. Sign in with your Microsoft 365 credentials
3. In the left sidebar, click **Tools** → **Bot management**
4. Click **+ New Bot**
5. Enter a name for your bot (e.g., `claude-dispatch-bot`)
6. Click **Add**

### Save Your Credentials

After creating the bot:
1. **Copy the Bot ID** - This is your `MICROSOFT_APP_ID`
2. Click on your bot name to open settings
3. Under **Client secrets**, click **Add a client secret**
4. **Copy the secret value immediately** - This is your `MICROSOFT_APP_PASSWORD`

> **Important**: Save these credentials securely. The secret won't be shown again.

---

## Step 2: Configure Messaging Endpoint

Your bot needs a public HTTPS endpoint to receive messages.

### For Development (ngrok)

1. Install [ngrok](https://ngrok.com/download)
2. Run: `ngrok http 3978`
3. Copy the HTTPS URL (e.g., `https://abc123.ngrok-free.app`)
4. In Teams Developer Portal → **Bot management** → Select your bot
5. Set **Endpoint address** to:
   ```
   https://abc123.ngrok-free.app/api/messages
   ```

### For Production Options

- **Cloudflare Tunnel**: Free, persistent URLs
- **Azure App Service**: If you want Azure hosting
- **Any HTTPS host**: AWS, GCP, Heroku, VPS, etc.

---

## Step 3: Create Teams App

1. In Teams Developer Portal, click **Apps** in the left sidebar
2. Click **+ New app**
3. Fill in the basic information:
   - **Short name**: `Claude Dispatch`
   - **Full name**: `Claude Dispatch - AI Code Assistant`
   - **Short description**: `Control Claude Code or OpenCode from Teams`
   - **Full description**: `Start, stop, and communicate with AI coding assistants directly from Microsoft Teams channels`
   - **Developer/Company name**: Your name or company

---

## Step 4: Configure App Features

### Add Bot Capability

1. In your app, go to **App features** in the left sidebar
2. Click **Bot**
3. Select **Enter a bot ID**
4. Enter your Bot ID from Step 1
5. Check the scopes where the bot can be used:
   - [x] **Team** - Use in channels
   - [x] **Group chat** - Use in group chats
   - [x] **Personal** - Use in 1:1 chats

### Configure Bot Commands

Under **Commands**, add these:

| Command | Description | Scope |
|---------|-------------|-------|
| `claude-start` | Start a Claude instance: claude-start <name> <path> | Team, Group chat |
| `claude-stop` | Stop a Claude instance: claude-stop <name> | Team, Group chat |
| `claude-list` | List all running Claude instances | Team, Group chat |
| `claude-send` | Send message: claude-send <name> <message> | Team, Group chat |

---

## Step 5: Add App Icons

1. Go to **Basic information** → **Branding**
2. Upload two icons:
   - **Color icon**: 192x192 pixels (PNG)
   - **Outline icon**: 32x32 pixels (transparent PNG)

> **Tip**: You can use placeholder icons initially and update later.

---

## Step 6: Configure Environment Variables

Create a `.env` file in the project root:

```env
# Microsoft Bot Framework credentials (from Step 1)
MICROSOFT_APP_ID=your-bot-id-here
MICROSOFT_APP_PASSWORD=your-client-secret-here

# Bot server configuration
PORT=3978

# Optional: For single-tenant apps, specify your tenant ID
# MICROSOFT_APP_TENANT_ID=your-tenant-id
```

---

## Step 7: Start the Bot Server

```bash
# Install dependencies
npm install

# Start the Teams bot
npm run start:teams
```

You should see:
```
Claude Dispatch (Teams) is starting...
Bot server listening on port 3978
```

---

## Step 8: Test Your Bot

### Preview in Teams

1. In Teams Developer Portal, go to your app
2. Click **Preview in Teams** (top right)
3. Select where to install (a team or chat)
4. Click **Add**

### Sideload for Testing

1. In your app, go to **Publish** → **Publish to your org**
2. Click **Download app package** to get the ZIP file
3. In Teams:
   - Click **Apps** in the sidebar
   - Click **Manage your apps** → **Upload an app**
   - Select **Upload a custom app**
   - Choose your ZIP file

---

## Step 9: Using the Bot

### Start an Instance

In a Teams channel or chat, mention the bot:
```
@Claude Dispatch claude-start my-project C:\path\to\project
```

### Send Messages

Once started, mention the bot with your message:
```
@Claude Dispatch What files are in this project?
```

Or use the direct command:
```
@Claude Dispatch claude-send my-project List all JavaScript files
```

### List Instances

```
@Claude Dispatch claude-list
```

### Stop an Instance

```
@Claude Dispatch claude-stop my-project
```

---

## Troubleshooting

### Bot Not Responding

1. **Check endpoint**: Verify ngrok is running and the URL is correct in Bot management
2. **Check credentials**: Ensure MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD match what's in Developer Portal
3. **Check logs**: Look at the bot server console for error messages

### "App Not Found" Error

1. Ensure the app is uploaded/installed
2. Check that custom app uploading is enabled in your tenant:
   - Teams Admin Center → Teams apps → Setup policies
   - Enable "Upload custom apps"

### Authentication Errors

```
Error: BotFrameworkAdapter: Unauthorized
```

1. Verify MICROSOFT_APP_ID is the Bot ID (not App ID from manifest)
2. Verify MICROSOFT_APP_PASSWORD is the client secret value
3. Check the secret hasn't expired

### Messages Not Being Processed

1. Ensure bot is mentioned (@Claude Dispatch) in channel messages
2. Personal chats don't require mentions
3. Verify the bot was added to the team/channel

---

## Advanced: Organization-wide Deployment

### Admin Center Deployment

1. Go to [Teams Admin Center](https://admin.teams.microsoft.com)
2. Navigate to **Teams apps** → **Manage apps**
3. Click **Upload new app**
4. Upload your app package (ZIP)
5. Configure **App setup policies** to make it available

### App Catalog Submission

For wider distribution:
1. In Developer Portal, go to **Publish** → **Publish to your org**
2. Submit for admin approval
3. Admins approve in Teams Admin Center

---

## Security Considerations

1. **Client Secret Rotation**: Set calendar reminders before expiry
2. **Tenant Restriction**: Use single-tenant for internal-only apps
3. **Permission Model**: The bot runs with `--dangerously-skip-permissions` flag. Restrict who can add the bot.
4. **Network Security**: For production, consider:
   - IP allowlisting
   - Private endpoints
   - VPN requirements

---

## Comparison: Azure Portal vs Developer Portal

| Aspect | Teams Developer Portal | Azure Portal |
|--------|----------------------|--------------|
| **Complexity** | Simpler, Teams-focused | More options, steeper learning curve |
| **Cost** | Free | Free for Teams channel |
| **Multi-tenant** | Single-tenant by default | Supports multi-tenant |
| **SSO Support** | Requires additional Entra ID setup | Built-in support |
| **Other channels** | Teams only | Slack, Web, etc. |
| **Best for** | Quick setup, Teams-only bots | Enterprise, multi-channel |

> **Note**: Both approaches use the same Bot Framework Service under the hood. The Developer Portal just simplifies the registration process.

---

## Production Hosting Options

### Option 1: Always-on Desktop (Simplest)

Run the bot on your development machine:
```bash
# Using PM2 for auto-restart
npm install -g pm2
pm2 start src/teams-bot.js --name claude-dispatch-teams
pm2 save
pm2 startup
```

### Option 2: Cloud VM

Deploy to any cloud VM (Azure, AWS, GCP, DigitalOcean):
1. Install Node.js 18+
2. Install Claude/OpenCode CLI
3. Clone the repo and configure .env
4. Run with PM2 or systemd

### Option 3: Container

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["npm", "run", "start:teams"]
```

---

## Support

For issues, please open a ticket at:
https://github.com/bobum/claude-dispatch/issues

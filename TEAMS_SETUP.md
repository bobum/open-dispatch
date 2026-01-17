# Microsoft Teams Setup Guide for Claude Dispatch

This guide walks you through setting up Claude Dispatch to work with Microsoft Teams instead of Slack.

## Overview

Claude Dispatch for Teams allows you to control Claude Code instances directly from Microsoft Teams channels. The bot uses the Microsoft Bot Framework with Azure Bot Service for communication.

## Prerequisites

- Node.js 18+ installed
- Azure subscription (free tier works for development)
- Microsoft 365 account with Teams access
- Admin access to your Microsoft 365 tenant (or ability to request app approval)
- Claude Code CLI installed and authenticated on the machine running the bot

## Architecture

```
Teams User → Microsoft Teams → Azure Bot Service → Your Bot Server → Claude CLI
                                      ↓
                              Bot Framework SDK
```

## Step 1: Create Azure Bot Resource

### Option A: Azure Portal (Recommended for Production)

1. Go to [Azure Portal](https://portal.azure.com)
2. Click **Create a resource** → Search for **Azure Bot**
3. Click **Create** and fill in:
   - **Bot handle**: `claude-dispatch` (must be unique)
   - **Subscription**: Select your subscription
   - **Resource group**: Create new or select existing
   - **Pricing tier**: F0 (Free) for development
   - **Microsoft App ID**: Select **Create new Microsoft App ID**
4. Click **Review + create** → **Create**
5. Once created, go to the resource

### Option B: Bot Framework Portal (Quick Start)

1. Go to [Bot Framework Portal](https://dev.botframework.com/)
2. Click **Create a bot** → **Create**
3. Follow the wizard to create your bot

## Step 2: Get Bot Credentials

1. In your Azure Bot resource, go to **Configuration**
2. Note the **Microsoft App ID** (you'll need this)
3. Click **Manage** next to Microsoft App ID
4. In the App Registration page:
   - Go to **Certificates & secrets**
   - Click **New client secret**
   - Add description: `claude-dispatch-secret`
   - Select expiration (24 months recommended)
   - Click **Add**
   - **IMPORTANT**: Copy the secret value immediately (you won't see it again)

## Step 3: Configure Messaging Endpoint

Your bot needs a public HTTPS endpoint. Options:

### For Development (ngrok)

1. Install [ngrok](https://ngrok.com/download)
2. Run: `ngrok http 3978`
3. Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)
4. In Azure Bot → Configuration → Messaging endpoint:
   ```
   https://abc123.ngrok.io/api/messages
   ```

### For Production (Azure App Service)

1. Deploy your bot to Azure App Service
2. Use the App Service URL:
   ```
   https://your-app-name.azurewebsites.net/api/messages
   ```

## Step 4: Enable Teams Channel

1. In Azure Bot resource, go to **Channels**
2. Click **Microsoft Teams** icon
3. Review and accept the Terms of Service
4. Click **Apply**
5. Teams channel is now enabled

## Step 5: Configure Environment Variables

Create a `.env` file in the project root:

```env
# Microsoft Bot Framework credentials
MICROSOFT_APP_ID=your-app-id-here
MICROSOFT_APP_PASSWORD=your-client-secret-here

# Bot server configuration
PORT=3978

# Optional: Tenant restriction (for single-tenant apps)
# MICROSOFT_APP_TENANT_ID=your-tenant-id
```

## Step 6: Create Teams App Manifest

Create a `teams-manifest` folder with these files:

### manifest.json

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "YOUR-APP-ID-HERE",
  "packageName": "com.yourcompany.claudedispatch",
  "developer": {
    "name": "Your Company",
    "websiteUrl": "https://github.com/bobum/claude-dispatch",
    "privacyUrl": "https://github.com/bobum/claude-dispatch",
    "termsOfUseUrl": "https://github.com/bobum/claude-dispatch"
  },
  "name": {
    "short": "Claude Dispatch",
    "full": "Claude Dispatch - Control Claude Code from Teams"
  },
  "description": {
    "short": "Control Claude Code instances from Teams",
    "full": "Claude Dispatch allows you to start, stop, and communicate with Claude Code instances directly from Microsoft Teams channels. Perfect for collaborative AI-assisted development."
  },
  "icons": {
    "outline": "outline.png",
    "color": "color.png"
  },
  "accentColor": "#6B4C9A",
  "bots": [
    {
      "botId": "YOUR-APP-ID-HERE",
      "scopes": ["team", "personal", "groupchat"],
      "supportsFiles": false,
      "isNotificationOnly": false,
      "commandLists": [
        {
          "scopes": ["team", "groupchat"],
          "commands": [
            {
              "title": "claude-start",
              "description": "Start a Claude instance: claude-start <name> <project-path>"
            },
            {
              "title": "claude-stop",
              "description": "Stop a Claude instance: claude-stop <name>"
            },
            {
              "title": "claude-list",
              "description": "List all running Claude instances"
            },
            {
              "title": "claude-send",
              "description": "Send message to instance: claude-send <name> <message>"
            }
          ]
        }
      ]
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
```

### Icons

You'll need two icon files in the `teams-manifest` folder:
- `color.png` - 192x192 pixel color icon
- `outline.png` - 32x32 pixel outline icon (transparent background)

## Step 7: Package and Upload Teams App

### Create the App Package

1. Update `manifest.json`:
   - Replace `YOUR-APP-ID-HERE` with your Microsoft App ID (in two places)
   - Update developer information
2. Create a ZIP file containing:
   - `manifest.json`
   - `color.png`
   - `outline.png`

### Upload to Teams

#### For Development/Testing (Sideloading)

1. In Teams, click **Apps** in the sidebar
2. Click **Manage your apps** → **Upload an app**
3. Select **Upload a custom app**
4. Choose your ZIP file
5. Click **Add** to install

#### For Organization-wide Deployment

1. Go to [Teams Admin Center](https://admin.teams.microsoft.com)
2. Navigate to **Teams apps** → **Manage apps**
3. Click **Upload new app**
4. Upload your ZIP file
5. Set app policies to allow the app

## Step 8: Start the Bot

```bash
# Install dependencies
npm install

# Start the bot
npm start
```

## Step 9: Add Bot to a Channel

1. In Teams, go to the channel where you want Claude
2. Click the **+** tab or go to channel settings
3. Click **Get more apps** or search for "Claude Dispatch"
4. Add the bot to the channel

## Usage

### Starting an Instance

In a Teams channel, type:
```
@Claude Dispatch claude-start my-project C:\path\to\project
```

### Sending Messages

Once started, any message in that channel will be sent to Claude:
```
@Claude Dispatch What files are in this project?
```

Or use the direct command:
```
@Claude Dispatch claude-send my-project List all JavaScript files
```

### Listing Instances

```
@Claude Dispatch claude-list
```

### Stopping an Instance

```
@Claude Dispatch claude-stop my-project
```

## Troubleshooting

### Bot Not Responding

1. Check that your messaging endpoint is accessible
2. Verify ngrok is running (for development)
3. Check Azure Bot Service health in Azure Portal
4. Review bot logs for errors

### "App Not Found" Error

1. Ensure the app is properly uploaded
2. Check that sideloading is enabled in your tenant
3. Verify the manifest.json has correct App ID

### Authentication Errors

1. Verify MICROSOFT_APP_ID matches Azure Bot configuration
2. Ensure MICROSOFT_APP_PASSWORD is correct (client secret, not ID)
3. Check secret hasn't expired

### Messages Not Being Processed

1. Ensure bot is mentioned in channel messages (@Claude Dispatch)
2. Check that the bot has permissions in the channel
3. Verify Teams channel is enabled in Azure Bot

## Security Considerations

1. **Client Secret**: Never commit your `.env` file. Use Azure Key Vault for production.
2. **Tenant Restriction**: Consider single-tenant deployment for internal use.
3. **Permissions**: The bot runs with `--dangerously-skip-permissions` flag. Ensure only authorized users have access.
4. **Network**: In production, restrict access to your bot endpoint via Azure networking.

## Production Deployment

For production, consider:

1. **Azure App Service**: Deploy the Node.js app
2. **Azure Key Vault**: Store secrets securely
3. **Application Insights**: Add monitoring and logging
4. **Auto-scaling**: Configure based on expected load

### Azure CLI Deployment Example

```bash
# Login to Azure
az login

# Create resource group
az group create --name claude-dispatch-rg --location eastus

# Create App Service plan
az appservice plan create --name claude-dispatch-plan --resource-group claude-dispatch-rg --sku B1 --is-linux

# Create web app
az webapp create --name claude-dispatch-bot --resource-group claude-dispatch-rg --plan claude-dispatch-plan --runtime "NODE|18-lts"

# Configure app settings
az webapp config appsettings set --name claude-dispatch-bot --resource-group claude-dispatch-rg --settings MICROSOFT_APP_ID=your-app-id MICROSOFT_APP_PASSWORD=your-secret

# Deploy code
az webapp deployment source config-local-git --name claude-dispatch-bot --resource-group claude-dispatch-rg
```

## Comparison: Slack vs Teams

| Feature | Slack | Teams |
|---------|-------|-------|
| Connection | Socket Mode (WebSocket) | HTTP Webhooks |
| Commands | Slash commands (/claude-start) | Bot mentions (@bot claude-start) |
| Authentication | Bot Token + App Token | Azure AD + Client Secret |
| Message Format | Markdown (mrkdwn) | Adaptive Cards / Markdown |
| Character Limit | 4,000 chars | 28 KB per message |
| Setup Complexity | Low (app dashboard) | Medium (Azure Portal + Teams Admin) |

## Support

For issues specific to this Teams implementation, please open an issue at:
https://github.com/bobum/claude-dispatch/issues

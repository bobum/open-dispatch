# Teams App Manifest

This folder contains the Microsoft Teams app manifest for Claude Dispatch.

## Files Required

1. **manifest.json** - App configuration (included, needs customization)
2. **color.png** - 192x192 pixel color icon (you need to create)
3. **outline.png** - 32x32 pixel outline icon with transparent background (you need to create)

## Setup Instructions

1. **Edit manifest.json:**
   - Replace `YOUR-MICROSOFT-APP-ID-HERE` with your Azure Bot's Microsoft App ID (appears in two places)
   - Update the `developer` section with your company info
   - Update URLs if you have custom privacy/terms pages

2. **Create icons:**
   - `color.png`: 192x192 pixels, full color icon for your bot
   - `outline.png`: 32x32 pixels, monochrome outline with transparent background

3. **Create the app package:**
   ```bash
   # From the teams-manifest directory
   zip -r ../claude-dispatch-teams.zip manifest.json color.png outline.png
   ```

4. **Upload to Teams:**
   - Go to Teams → Apps → Manage your apps → Upload an app
   - Select "Upload a custom app"
   - Choose `claude-dispatch-teams.zip`

## Icon Suggestions

For a quick start, you can create simple icons:

**color.png (192x192):**
- Purple/violet background (#6B4C9A)
- White "CD" letters or a simple bot icon

**outline.png (32x32):**
- Transparent background
- White or single-color outline of the same design

## Manifest Customization

### For Single-Tenant Deployment

If you want to restrict the app to your organization only, you can add tenant restrictions in your Azure Bot configuration rather than in the manifest.

### Adding More Commands

To add new bot commands, edit the `commandLists` array in `manifest.json`. Commands are shown as suggestions when users type in Teams.

### Updating Permissions

The default permissions are:
- `identity` - Access user identity info
- `messageTeamMembers` - Send messages to team members

Add more as needed based on your requirements.

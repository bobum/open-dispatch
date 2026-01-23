/**
 * Chat Providers Index
 *
 * Re-exports all available chat providers and utility functions.
 */

// Base class and utilities
const {
  ChatProvider,
  registerProvider,
  getProvider,
  listProviders,
  createProvider
} = require('./chat-provider');

// Platform-specific providers
const { SlackProvider } = require('./slack-provider');
const { TeamsProvider } = require('./teams-provider');
const { DiscordProvider } = require('./discord-provider');

module.exports = {
  // Base class
  ChatProvider,

  // Registry functions
  registerProvider,
  getProvider,
  listProviders,
  createProvider,

  // Provider classes
  SlackProvider,
  TeamsProvider,
  DiscordProvider
};

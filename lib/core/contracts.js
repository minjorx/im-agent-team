/**
 * Contracts between the channel-independent core and its adapters.
 *
 * These are documentation types, not runtime classes: core code only relies on
 * the methods below, so a new channel or runtime never needs to import another
 * adapter's implementation.
 *
 * @module lib/core/contracts
 */

/** Bump when a contract changes in a way adapters must follow. */
export const CONTRACTS_VERSION = 1;

/**
 * One normalized inbound message.
 * @typedef {Object} InboundMessage
 * @property {'feishu'|string} platform
 * @property {string} appId
 * @property {string} messageId
 * @property {string} chatId
 * @property {'p2p'|'group'} chatType
 * @property {string} [chatName]
 * @property {{ type: 'user'|'bot', openId?: string, unionId?: string, name?: string }} sender
 * @property {string} text
 * @property {Array<{ key?: string, openId: string, unionId?: string, name: string, type: 'user'|'bot' }>} mentions
 * @property {boolean} mentionedMe
 * @property {boolean} mentionedAll
 * @property {{ trace: string, hop: number, kind: string, taskId?: string, deadline?: string }} [envelope]
 * @property {number} createTime
 */

/**
 * One outbound message for a channel.
 * @typedef {Object} OutboundMessage
 * @property {string} chatId
 * @property {'text'|'post'|'interactive'} msgType
 * @property {string} content JSON-encoded platform payload
 * @property {string} [uuid]
 * @property {string} [replyTo]
 */

/**
 * A messaging platform adapter.
 * @typedef {Object} ChannelAdapter
 * @property {string} status
 * @property {(message: OutboundMessage) => Promise<Object>} send
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 */

/**
 * An AI runtime adapter.
 * @typedef {Object} AgentRuntime
 * @property {string} status
 * @property {(text: string) => Promise<void>} submit
 * @property {() => Promise<void>} ensure
 * @property {() => Promise<void>} cancel
 * @property {() => Promise<void>} waitForTurn
 * @property {() => Promise<void>} dispose
 * @property {() => Object} info
 */

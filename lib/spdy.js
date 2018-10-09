'use strict'

// Export tools
exports.handle = require('./spdy/handle').Handle
exports.request = require('./spdy/request')
exports.response = require('./spdy/response')
exports.Socket = require('./spdy/socket')

// Export client
exports.agent = require('./spdy/agent')
exports.Agent = exports.agent.Agent
exports.createAgent = exports.agent.create
exports.https = require('https')
exports.get = exports.https.get

// Export server
exports.server = require('./spdy/server')
exports.Server = exports.server.Server
exports.PlainServer = exports.server.PlainServer
exports.createServer = exports.server.create
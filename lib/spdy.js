'use strict'
var https = require('https')
var spdy = exports

// Export tools
spdy.handle = require('./spdy/handle')
spdy.request = require('./spdy/request')
spdy.response = require('./spdy/response')
spdy.Socket = require('./spdy/socket')

// Export client
spdy.agent = require('./spdy/agent')
spdy.Agent = spdy.agent.Agent
spdy.createAgent = spdy.agent.create
spdy.https = https
spdy.get = https.get

// Export server
spdy.server = require('./spdy/server')
spdy.Server = spdy.server.Server
spdy.PlainServer = spdy.server.PlainServer
spdy.createServer = spdy.server.create

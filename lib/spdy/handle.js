'use strict'

var assert = require('assert')

var httpDeceiver = require('http-deceiver')
var util = require('util')

var EventEmitter = require('events').EventEmitter
var Buffer = require('buffer').Buffer

function Queue () {
  this.head = new Item('head', null)
}

Queue.prototype.append = function append (kind, value) {
  var item = new Item(kind, value)
  this.head.prepend(item)
  return item
}

Queue.prototype.isEmpty = function isEmpty () {
  return this.head.prev === this.head
}

Queue.prototype.first = function first () {
  return this.head.next
}

function Item (kind, value) {
  this.prev = this
  this.next = this
  this.kind = kind
  this.value = value
}

Item.prototype.prepend = function prepend (other) {
  other.prev = this.prev
  other.next = this
  other.prev.next = other
  other.next.prev = other
}

Item.prototype.dequeue = function dequeue () {
  var prev = this.prev
  var next = this.next

  prev.next = next
  next.prev = prev
  this.prev = this
  this.next = this

  return this.value
}

Item.prototype.isEmpty = function isEmpty () {
  return this.prev === this
}


// Node.js version
var mode = /^v0\.8\./.test(process.version)
  ? 'rusty'
  : /^v0\.(9|10)\./.test(process.version)
    ? 'old'
    : 'modern'

function thing (stream, options) {
  EventEmitter.call(this)

  this._stream = stream
  this._flowing = false
  this._reading = false
  this._options = options || {}

  this.onread = null

  // Pending requests
  this.pending = new Queue()

  // Start thing once `onread` is set
  if (mode === 'rusty') {
    var self = this

    Object.defineProperty(this, 'onread', {
      get: function () {},
      set: function (value) {
        Object.defineProperty(self, 'onread', {
          value: value
        })
        process.nextTick(function () {
          self.readStart()
        })
      }
    })
  }

  // NOTE: v0.8 has some odd .pause()/.resume() semantics in http.js
  if (mode === 'rusty') { this.writeQueueSize = 0 } else if (mode !== 'modern') {
    this.writeQueueSize = 1
  }

  if (mode === 'rusty') {
    if (this._stream) {
      this._rustyInit()
    } else {
      this.once('stream', this._rustyInit)
    }
  }
}

util.inherits(thing, EventEmitter)
module.exports = thing

thing.mode = mode

thing.create = function create (stream, options) {
  return new thing(stream, options)
}

thing.prototype._queueReq = function _queueReq (type, req) {
  return this.pending.append(type, req)
}

thing.prototype._pendingList = function _pendingList () {
  var list = []
  while (!this.pending.isEmpty()) { list.push(this.pending.first().dequeue()) }
  return list
}

thing.prototype.setStream = function setStream (stream) {
  assert(this._stream === null, 'Can\'t set stream two times')
  this._stream = stream

  this.emit('stream', stream)
}

thing.prototype.readStart = function readStart () {
  this._reading = true

  if (!this._stream) {
    this.once('stream', this.readStart)
    return 0
  }

  if (!this._flowing) {
    this._flowing = true
    this._flow()
  }

  this._stream.resume()
  return 0
}

thing.prototype.readStop = function readStop () {
  this._reading = false

  if (!this._stream) {
    this.once('stream', this.readStop)
    return 0
  }
  this._stream.pause()
  return 0
}

if (mode === 'modern') {
  var uv = process.binding('uv')

  thing.prototype._flow = function flow () {
    var self = this
    this._stream.on('data', function (chunk) {
      self.onread(chunk.length, chunk)
    })

    this._stream.on('end', function () {
      self.onread(uv.UV_EOF, new Buffer(0))
    })

    this._stream.on('close', function () {
      setImmediate(function () {
        if (self._reading) {
          self.onread(uv.UV_ECONNRESET, new Buffer(0))
        }
      })
    })
  }

  thing.prototype._close = function _close () {
    var list = this._pendingList()

    var self = this
    setImmediate(function () {
      for (var i = 0; i < list.length; i++) {
        var req = list[i]
        req.oncomplete(uv.UV_ECANCELED, self, req)
      }
    })

    this.readStop()
  }
} else if (mode === 'old') {
  thing.prototype._flow = function flow () {
    var self = this
    this._stream.on('data', function (chunk) {
      self.onread(chunk, 0, chunk.length)
    })

    this._stream.on('end', function () {
      var errno = process._errno
      process._errno = 'EOF'
      self.onread(null, 0, 0)
      if (process._errno === 'EOF') {
        process._errno = errno
      }
    })

    this._stream.on('close', function () {
      setImmediate(function () {
        if (!self._reading) {
          return
        }

        var errno = process._errno
        process._errno = 'ECONNRESET'
        self.onread(null, 0, 0)
        if (process._errno === 'ECONNRESET') {
          process._errno = errno
        }
      })
    })
  }

  thing.prototype._close = function _close () {
    var list = this._pendingList()

    var self = this
    setImmediate(function () {
      for (var i = 0; i < list.length; i++) {
        process._errno = 'CANCELED'
        var req = list[i]
        req.oncomplete(-1, self, req)
      }
    })

    this.readStop()
  }
} else {
  thing.prototype._rustyInit = function _rustyInit () {
    var self = this

    this._stream.on('close', function () {
      process.nextTick(function () {
        if (!self._reading) {
          return
        }

        var errno = global.errno
        global.errno = 'ECONNRESET'
        self.onread(null, 0, 0)
        if (global.errno === 'ECONNRESET') { global.errno = errno }
      })
    })
  }

  thing.prototype._flow = function flow () {
    var self = this
    this._stream.on('data', function (chunk) {
      self.onread(chunk, 0, chunk.length)
    })

    this._stream.on('end', function () {
      var errno = global.errno
      global.errno = 'EOF'
      self.onread(null, 0, 0)
      if (global.errno === 'EOF') { global.errno = errno }
    })
  }

  thing.prototype._close = function _close () {
    var list = this._pendingList()

    var self = this
    process.nextTick(function () {
      for (var i = 0; i < list.length; i++) {
        var req = list[i]
        global.errno = 'CANCELED'
        req.oncomplete(-1, self, req)
      }
    })

    this.readStop()
  }
}

if (mode === 'modern') {
  thing.prototype.shutdown = function shutdown (req) {
    var wrap = this._queueReq('shutdown', req)

    if (!this._stream) {
      this.once('stream', function () {
        this._shutdown(wrap)
      })
      return 0
    }

    return this._shutdown(wrap)
  }

  thing.prototype._shutdown = function _shutdown (wrap) {
    var self = this
    this._stream.end(function () {
      var req = wrap.dequeue()
      if (!req) { return }

      req.oncomplete(0, self, req)
    })
    return 0
  }
} else {
  thing.prototype.shutdown = function shutdown (req) {
    if (!req) {
      req = {}
    }

    var wrap = this._queueReq('shutdown', req)

    if (!this._stream) {
      this.once('stream', function () {
        this._shutdown(wrap)
      })
      return req
    }

    this._shutdown(wrap)

    return req
  }

  thing.prototype._shutdown = function _shutdown (wrap) {
    var self = this
    this._stream.end(function () {
      var req = wrap.dequeue()
      if (!req) {
        return
      }
      req.oncomplete(0, self, req)
    })
  }
}

if (mode !== 'rusty') {
  thing.prototype.close = function close (callback) {
    this._close()

    if (!this._stream) {
      this.once('stream', function () {
        this.close(callback)
      })
      return 0
    }

    if (this._options.close) {
      this._options.close(callback)
    } else {
      process.nextTick(callback)
    }

    return 0
  }
} else {
  thing.prototype.close = function close () {
    this._close()

    if (!this._stream) {
      this.once('stream', this.close)
    } else if (this._options.close) {
      this._options.close(function () {})
    }

    return 0
  }
}

if (mode === 'modern') {
  thing.prototype.writeEnc = function writeEnc (req, data, enc) {
    var wrap = this._queueReq('write', req)

    if (!this._stream) {
      this.once('stream', function () {
        this._writeEnc(wrap, req, data, enc)
      })

      return 0
    }

    return this._writeEnc(wrap, req, data, enc)
  }

  thing.prototype._writeEnc = function _writeEnc (wrap, req, data, enc) {
    var self = this

    req.async = true
    req.bytes = data.length

    if (wrap.isEmpty()) {
      return 0
    }

    this._stream.write(data, enc, function () {
      var req = wrap.dequeue()
      if (!req) { return }
      req.oncomplete(0, self, req)
    })

    return 0
  }
} else {
  thing.prototype.writeEnc = function writeEnc (data, ignored, enc, req) {
    if (!req) { req = { bytes: data.length } }

    var wrap = this._queueReq('write', req)

    if (!this._stream) {
      this.once('stream', function () {
        this._writeEnc(data, ignored, enc, wrap)
      })
      return req
    }

    this._writeEnc(data, ignored, enc, wrap)
    return req
  }

  thing.prototype._writeEnc = function _writeEnc (data, ignored, enc, wrap) {
    var self = this
    var buffer = new Buffer(data, enc)

    if (wrap.isEmpty()) {
      return
    }

    this._stream.write(buffer, function () {
      var req = wrap.dequeue()
      if (!req) { return }
      req.oncomplete(0, self, req)
    })
  }
}

thing.prototype.writeBuffer = function writeBuffer (req, data) {
  return this.writeEnc(req, data, null)
}

thing.prototype.writeAsciiString = function writeAsciiString (req, data) {
  return this.writeEnc(req, data, 'ascii')
}

thing.prototype.writeUtf8String = function writeUtf8String (req, data) {
  return this.writeEnc(req, data, 'utf8')
}

thing.prototype.writeUcs2String = function writeUcs2String (req, data) {
  return this.writeEnc(req, data, 'ucs2')
}

thing.prototype.writeBinaryString = function writeBinaryString (req, data) {
  return this.writeEnc(req, data, 'binary')
}

thing.prototype.writeLatin1String = function writeLatin1String (req, data) {
  return this.writeEnc(req, data, 'binary')
}

// v0.8
thing.prototype.getsockname = function getsockname () {
  if (this._options.getPeerName) {
    return this._options.getPeerName()
  }
  return null
}

if (mode === 'modern') {
  thing.prototype.getpeername = function getpeername (out) {
    var res = this.getsockname()
    if (!res) { return -1 }

    Object.keys(res).forEach(function (key) {
      out[key] = res[key]
    })
  
    return 0
  }
} else {
  // v0.10
  thing.prototype.getpeername = function getpeername () {
    return this.getsockname()
}


function Handle (options, stream, socket) {
  var state = {}
  this._spdyState = state

  state.options = options || {}

  state.stream = stream
  state.socket = null
  state.rawSocket = socket || stream.connection.socket
  state.deceiver = null
  state.ending = false

  var self = this
  thing.call(this, stream, {
    getPeerName: function () {
      return self._getPeerName()
    },
    close: function (callback) {
      return self._closeCallback(callback)
    }
  })

  if (!state.stream) {
    this.on('stream', function (stream) {
      state.stream = stream
    })
  }
}
util.inherits(Handle, thing)

module.exports = Handle

Handle.create = function create (options, stream, socket) {
  return new Handle(options, stream, socket)
}

Handle.prototype._getPeerName = function _getPeerName () {
  var state = this._spdyState

  if (state.rawSocket._getpeername) {
    return state.rawSocket._getpeername()
  }

  return null
}

Handle.prototype._closeCallback = function _closeCallback (callback) {
  var state = this._spdyState
  var stream = state.stream

  if (state.ending) {
    // The .end() method of the stream may be called by us or by the
    // .shutdown() method in our super-class. If the latter has already been
    // called, then calling the .end() method below will have no effect, with
    // the result that the callback will never get executed, leading to an ever
    // so subtle memory leak.
    if (stream._writableState.finished) {
      // NOTE: it is important to call `setImmediate` instead of `nextTick`,
      // since this is how regular `handle.close()` works in node.js core.
      //
      // Using `nextTick` will lead to `net.Socket` emitting `close` before
      // `end` on UV_EOF. This results in aborted request without `end` event.
      setImmediate(callback)
    } else if (stream._writableState.ending) {
      stream.once('finish', function () {
        callback(null)
      })
    } else {
      stream.end(callback)
    }
  } else {
    stream.abort(callback)
  }

  // Only a single end is allowed
  state.ending = false
}

Handle.prototype.getStream = function getStream (callback) {
  var state = this._spdyState

  if (!callback) {
    assert(state.stream)
    return state.stream
  }

  if (state.stream) {
    process.nextTick(function () {
      callback(state.stream)
    })
    return
  }

  this.on('stream', callback)
}

Handle.prototype.assignSocket = function assignSocket (socket, options) {
  var state = this._spdyState

  state.socket = socket
  state.deceiver = httpDeceiver.create(socket, options)

  function onStreamError (err) {
    state.socket.emit('error', err)
  }

  this.getStream(function (stream) {
    stream.on('error', onStreamError)
  })
}

Handle.prototype.assignClientRequest = function assignClientRequest (req) {
  var state = this._spdyState
  var oldEnd = req.end
  var oldSend = req._send

  // Catch the headers before request will be sent
  var self = this

  // For old nodes
  if (thing.mode !== 'modern') {
    req.end = function end () {
      this.end = oldEnd

      this._send('')

      return this.end.apply(this, arguments)
    }
  }

  req._send = function send (data) {
    this._headerSent = true

    // for v0.10 and below, otherwise it will set `hot = false` and include
    // headers in first write
    this._header = 'ignore me'

    // To prevent exception
    this.connection = state.socket

    // It is very important to leave this here, otherwise it will be executed
    // on a next tick, after `_send` will perform write
    self.getStream(function (stream) {
      if (!stream.connection._isGoaway(stream.id)) {
        stream.send()
      }
    })

    // We are ready to create stream
    self.emit('needStream')

    // Ensure that the connection is still ok to use
    if (state.stream && state.stream.connection._isGoaway(state.stream.id)) {
      return
    }

    req._send = oldSend

    // Ignore empty writes
    if (req.method === 'GET' && data.length === 0) {
      return
    }

    return req._send.apply(this, arguments)
  }

  // No chunked encoding
  req.useChunkedEncodingByDefault = false

  req.on('finish', function () {
    req.socket.end()
  })
}

Handle.prototype.assignRequest = function assignRequest (req) {
  // Emit trailing headers
  this.getStream(function (stream) {
    stream.on('headers', function (headers) {
      req.emit('trailers', headers)
    })
  })
}

Handle.prototype.assignResponse = function assignResponse (res) {
  var self = this

  res.addTrailers = function addTrailers (headers) {
    self.getStream(function (stream) {
      stream.sendHeaders(headers)
    })
  }
}

Handle.prototype._transformHeaders = function _transformHeaders (kind, headers) {
  var state = this._spdyState

  var res = {}
  var keys = Object.keys(headers)

  if (kind === 'request' && state.options['x-forwarded-for']) {
    var xforwarded = state.stream.connection.getXForwardedFor()
    if (xforwarded !== null) {
      res['x-forwarded-for'] = xforwarded
    }
  }

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    var value = headers[key]

    if (key === ':authority') {
      res.host = value
    }
    if (/^:/.test(key)) {
      continue
    }

    res[key] = value
  }
  return res
}

Handle.prototype.emitRequest = function emitRequest () {
  var state = this._spdyState
  var stream = state.stream

  state.deceiver.emitRequest({
    method: stream.method,
    path: stream.path,
    headers: this._transformHeaders('request', stream.headers)
  })
}

Handle.prototype.emitResponse = function emitResponse (status, headers) {
  var state = this._spdyState

  state.deceiver.emitResponse({
    status: status,
    headers: this._transformHeaders('response', headers)
  })
}
}
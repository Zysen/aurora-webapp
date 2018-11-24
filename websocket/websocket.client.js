goog.provide('aurora.websocket');

goog.require('aurora.websocket.constants');
goog.require('aurora.websocket.enums');

/**
 * @enum {number}
 */
aurora.websocket.CON_STATUS = {
    DISCONNECTED: 0, CONNECTED: 1, ERRORED: 2
};

function convertData(data) {
    if (typeof(data) === 'string') {
        return {type: aurora.websocket.enums.types.STRING, data: data};
    }
    else if (typeof(data) === 'object') {
        if (data instanceof ArrayBuffer || data instanceof Blob) {
            return {type: aurora.websocket.enums.types.BINARY, data: data};
        }
        return {type: aurora.websocket.enums.types.OBJECT, data: JSON.stringify(data)};
    }
    else {
        console.error('convertData Unknown type ' + typeof(data));
    }
}

function arrayBufferToString(ab) {
    return new TextDecoder("utf-8").decode(new Uint8Array(ab));
}

function toUInt16ArrayBuffer(data, littleEndian) {
    littleEndian = littleEndian || true;
    if (typeof(data) === 'number') {
        data = [data];
    }
    var ab = new ArrayBuffer(data.length * 2);
    var dv = new DataView(ab);
    for (var index in data) {
        dv.setUint16(index * 2, data[index], littleEndian);
    }
    return ab;
}

var channels = {};
var onReadyCallbacks = [];

/**
 * @private
 */
aurora.websocket.statusCallbacks_ = [];

/**
 * @private
 * at the moment this can only be NO_SESSION
 */
aurora.websocket.errorCallbacks_ = [];

/**
 * @private
 */
aurora.websocket.status_ = aurora.websocket.CON_STATUS.DISCONNECTED;

/**
 * @private
 */
aurora.websocket.pending_ = [];
/**
 * @type {WebSocket}
 */
var connection;

/**
 * @param {function(aurora.websocket.CON_STATUS)} cb
 */
aurora.websocket.onStatusChanged = function(cb) {
    aurora.websocket.statusCallbacks_.push(cb);
    if (connection && connection.ready) {
        cb(aurora.websocket.status_);
    }
};

/**
 * @param {function({error:aurora.websocket.error})} cb
 */
aurora.websocket.onError = function(cb) {
    aurora.websocket.errorCallbacks_.push(cb);
};
/**
 * @param {function()} cb
 */
aurora.websocket.onReady = function(cb) {
    onReadyCallbacks.push(cb);
    if (connection && connection.ready) {
        cb();
    }
};

/**
 */
aurora.websocket.connect = function () {
    if (connection) {
        return;
    }
    connection = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + window.location.hostname + ':' + window.location.port + '/websocket');
    connection.ready = false;
    connection.onopen = function() {
        console.log('WS connection established');
        connection.ready = true;
        // other onready callback may add to array while we are doing these callbacks
        onReadyCallbacks.slice(0).forEach(function(cb) {
            cb();
        });
        aurora.websocket.status_ = aurora.websocket.CON_STATUS.CONNECTED;
        aurora.websocket.statusCallbacks_.slice(0).forEach(function (cb) {
            cb(aurora.websocket.status_);
        });
        var pending = aurora.websocket.pending_;
        while (pending.length > 0) {
            pending.shift()();
        }
    };
    connection.onerror = function(error) {
        aurora.websocket.status_ = aurora.websocket.CON_STATUS.ERRORED;
        console.log("errored ws", error);
        aurora.websocket.statusCallbacks_.slice(0).forEach(function (cb) {
            cb(aurora.websocket.status_);
        });
    };
    connection.onclose = function(evt) {
        aurora.websocket.status_ = aurora.websocket.CON_STATUS.DISCONNECTED;
        connection = null;
        if (evt.code !== 1000) {
            // if 1000 is a normal closure basically we are changing pages
            // in firefox don't send events because it behaves differently on
            // firefox than chrome don't send message websocket should never close
            // under normal circumstances
            
            aurora.websocket.statusCallbacks_.slice(0).forEach(function (cb) {
                cb(aurora.websocket.status_);
            });
        }

	setTimeout(function(){
	    aurora.websocket.connect();
	}, 4000);
    };
    var websocketPluginId = aurora.websocket.constants.plugins.indexOf('websocket');
    
    connection.onmessage = function(packet) {
        if (packet.data instanceof Blob) {
            var reader = new FileReader();
            reader.onload = function() {
                var data = reader.result;
                var header = new Uint16Array(reader.result.slice(0, 6));
                var pluginId = header[0];
                var channelId = header[1];
                var type = header[2];
                var channel = channels[pluginId + '_' + channelId];
                var decodedData = null;
                if (type === aurora.websocket.enums.types.STRING) {
                    decodedData = arrayBufferToString(reader.result.slice(6));
                }
                else if (type === aurora.websocket.enums.types.OBJECT) {
                    decodedData = JSON.parse(arrayBufferToString(reader.result.slice(6)));
                }
                else if (type === aurora.websocket.enums.types.BINARY) {
                    decodedData = reader.result.slice(6);
                }
                else {
                    console.error('Websocket Receive: Unknown Type', type);
                    return;
                }

                if (channel) {
                    channel.receive({data: decodedData});
                }
                else if (pluginId === websocketPluginId) {
                    console.log("recived webSocket error");
                    aurora.websocket.errorCallbacks_.slice(0).forEach(function (cb) {
                        cb(decodedData);
                    });
                }
            };
            reader.readAsArrayBuffer(packet.data);
        }
        else {
            try {
                var m = JSON.parse(packet.data);
                console.log('Internal Channel Message', m);
            } catch (e) {
                console.log("This doesn't look like valid JSON: ", packet.data, e);
                return;
            }
        }

    };
};

window.addEventListener('load', function() {
    window.WebSocket = window.WebSocket || window.MozWebSocket;
    aurora.websocket.connect();
}, false);

/**
 * @constructor
 * @param {number} pluginId
 * @param {number} channelId
 * @param {function({data:?})} messageCb
 */
function Channel(pluginId, channelId, messageCb) {
    var callbacks = [messageCb];
    aurora.websocket.onReady(function() {
        if (connection) {
            connection.send(JSON.stringify({'command': aurora.websocket.enums.COMMANDS.REGISTER, 'pluginId': pluginId, 'channelId': channelId}));
        }
    });

    this.send = function(sendBuffer) {
        var data = convertData(sendBuffer);
        var doIt = function() {
            if (connection) {
                /**
                 * according to the documentation and it works you can send a blob but the 
                 * compiler is complaining
                 */
                connection.send(/** @type {?} */ (new Blob([toUInt16ArrayBuffer([pluginId, channelId, data.type], true), data.data])));
            }
        };
        if (connection && connection.ready) {
            doIt();
        }
        else {
            aurora.websocket.pending_.push(doIt);
        }


    };
    this.destroy = function() {
        if (connection) {
            connection.send(JSON.stringify({command: aurora.websocket.enums.COMMANDS.UNREGISTER, pluginId: pluginId, channelId: channelId}));
        }
    };
    this.addCallback = function(cb) {
        callbacks.push(cb);
    };
    this.receive = function(data) {
        callbacks.forEach(function(cb) {
            cb(data);
        });
    };
}

/**
 * @param {string} pluginName
 * @param {number} channelId
 * @param {function(?)} messageCallback
 * @return {?Channel}
 */
aurora.websocket.getChannel = function(pluginName, channelId, messageCallback) {
    var pluginId = aurora.websocket.constants.plugins.indexOf(pluginName);
    if (pluginId < 0) {
        console.error('websocket.getChannel no plugin called ' + pluginName);
        return null;
    }
    // I think this will get confusing especially if on widget sends a destroy
    // or gets a message for another widget
    var channel = channels[pluginId + '_' + channelId];
    if (channel === undefined) {
        channel = new Channel(pluginId, channelId, messageCallback);
        channels[pluginId + '_' + channelId] = channel;
    }
    else {
        channel.addCallback(messageCallback);
    }
    return channel;
};

/**
 * @param {string} pluginName
 * @param {number} channelId
 * @param {function(?)} messageCallback
 * @return {?Channel}
 */

aurora.websocket.getObjectChannel = function(pluginName, channelId, messageCallback) {
    return aurora.websocket.getChannel(pluginName, channelId, function(v) {
        messageCallback(v.data);
    });
};

goog.provide('aurora.http');
goog.require('config');
goog.require('goog.structs.AvlTree');
goog.require('recoil.util.object');

/**
 * @typedef {{set:function(string,?),get:function(string),toClient:function():Array<string>}}
 */
aurora.http.ResponseHeaders;

/**
 * @typedef {{port:number,protocol:string,websocket:?boolean,key:?buffer.Buffer,cert:?buffer.Buffer}}
 */
aurora.http.ConfigServerType;
/**
 * @typedef {{responseHeaders:aurora.http.ResponseHeaders,request:http.IncomingMessage, response:http.ServerResponse,
 *          data:?, outUrl:string, cookies:Object<string,string>,url:url.URL, token:?}}
 */
aurora.http.RequestState;

/**
 * @typedef {{servers:Array<aurora.http.ConfigServerType>,directoryBrowsing:boolean,defaultPage:string,sourceDirectory:string,serverDescription:string,theme:string}}
 */
aurora.http.ConfigType;

/**
 * @typedef {{server:?,config:aurora.http.ConfigServerType}}
 */
aurora.http.Server;

/**
 * @param {string} str
 * @return {string}
 */
aurora.http.escapeRegExp = function(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
};

(function() {

    var types = aurora.websocket.enums.types;
    var COMMANDS = aurora.websocket.enums.COMMANDS;
    //TODO: Send an object that contains a binary field.

    const node_http = require('http');
    const node_https = require('https');
    const mime = require('mime');
    const fs = require('fs');
    const path = require('path');
    const urlLib = require('url');
    const qs = require('querystring');
    const EventEmitter = require('events').EventEmitter;

    aurora.http.serversUpdatedE = new EventEmitter();

    var theme = {};
    aurora.http.theme = theme;
    var callbacks = new goog.structs.AvlTree(recoil.util.object.compareKey);

    /**
     * @param {!aurora.http.RequestState} state
     **/
    aurora.http.notFound = function (state) {
        state.response.writeHead(404, state.responseHeaders.toClient());
        state.response.end(theme.error404HTML);
    };
    aurora.http.getPost = function(request, callback) {
        if (request.method == 'POST') {
            var body = '';
            request.on('data', function(data) {
                body += data;
            });
            request.on('end', function() {
                callback(qs.parse(body));
            });
            return true;
        }
        return false;
    };

    /**
     * @param {number} priority lower priority go first also if callback returns a non-false value
     * all other requests of the same priority are skipped
     * @param {RegExp|string} pattern
     * @param {function(aurora.http.RequestState):?} callback if this returns false then it will stop any more callbacks
     */
    aurora.http.addRequestCallback = function(priority, pattern, callback) {
        var existing = callbacks.findFirst({key: priority});
        var pat = typeof (pattern) === 'string' ? new RegExp('^' + pattern) : pattern;
        var data = {pattern: pattern, callback: callback};
        if (existing) {
            existing.callbacks.push(data);
        }
        else {
            callbacks.add({key: priority, callbacks: [data]});
        }
    };
    /**
     * @param {RegExp|string} pattern
     * @param {function(aurora.http.RequestState):?} callback if this returns false then it will stop any more callbacks
     */
    aurora.http.addPreRequestCallback = function(pattern, callback) {
        aurora.http.addRequestCallback(0, pattern, callback);
    };
    /**
     * @param {RegExp|string} pattern
     * @param {function(aurora.http.RequestState):?} callback if this returns false then it will stop any more callbacks
     */
    aurora.http.addMidRequestCallback = function(pattern, callback) {
        aurora.http.addRequestCallback(5, pattern, callback);
    };

    function startServer(type, port, callback, opt_options) {
        var running = true;
        var httpServer = (opt_options && type === node_https) ? type.createServer(opt_options, callback) : type.createServer(callback);
        var serverSockets = {}, nextSocketId = 0;
        httpServer.on('connection', function(socket) {
            var socketId = nextSocketId++;
            serverSockets[socketId] = socket;
            socket.on('close', function() {
                delete serverSockets[socketId];
            });
        });
        httpServer.shutdown = function(doneCb) {
            console.log('HTTP Server Shutdown ' + port, nextSocketId);
            httpServer.close(function() {
                for (var index in serverSockets) {serverSockets[index].destroy();}
                running = false;
                doneCb();
            });
        };
        httpServer.listen(port);
        return httpServer;
    };

    var responseHeadersDef = (function() {
        var headers = {'Server': [config['http']['serverDescription'] || 'AuroraHTTP'], 'Date': [(new Date()).toGMTString()]};
        return {
            set: function(name, value) {
                if (headers[name] !== undefined) {
                    headers[name].push(value);
                }
                else {
                    headers[name] = [value];
                }
            },
            get: function(name) {
                if (headers[name] !== undefined) {
                    if (headers[name].length === 1) {
                        return headers[name][0];
                    }
                    else {
                        return headers[name];
                    }
                }
                return undefined;
            },
            toClient: function() {
                var newHeaders = [];
                Object.keys(headers).forEach(function(name) {
                    headers[name].forEach(function(v) {
                        newHeaders.push([name, v]);
                    });
                });
                return newHeaders;
            }
        };
    });

    /**
     * sends a file to the client
     * this checks timestamps and sends not modified if already exits, it will also send the .gz
     * version if it exists if the opt_sendGz is set to true
     *
     * @param {string} path
     * @param {http.IncomingMessage} request
     * @param {http.ServerResponse} response
     * @param {?} headers
     * @param {boolean=} opt_sendGz
     */
    function sendFile(path, request, response, headers, opt_sendGz) {

        var doSend = function(stats, path, decompress) {
            var reqDate = request.headers['if-modified-since'];
            if (reqDate !== undefined && new Date(reqDate).getUTCSeconds() === new Date(stats.mtime).getUTCSeconds()) {
                response.writeHead(304, headers.toClient());
                response.end();
            }
            else {
                headers.set('Content-Length', stats.size);
                if (decompress) {
                    headers.set('Content-Type', mime.getType(decompress));
                    headers.set('Content-Encoding', 'gzip');
                }
                else {
                    headers.set('Content-Type', mime.getType(path));
                }
                headers.set('Accept-Ranges', 'bytes');
                headers.set('Cache-Control', 'no-cache, must-revalidate');
                headers.set('Last-Modified', stats.mtime.toGMTString());
                response.writeHead(200, headers.toClient());

                var readStream = fs.createReadStream(path);
                readStream.pipe(/** @type {?} */(response));
                readStream.on('error', function(err) {
                    if (response !== null) {
                        response.writeHead(500, headers.toClient());
                        response.end(theme.error500HTML);
                    }
                });
                readStream.on('end', function(err) {
                    if (response) {
                        response.end();
                    }
                });
                request.on('close', function() {
                    readStream.unpipe(/** @type {?} */(response));
                    readStream.destroy();
                    if (response !== null) {
                        response.end();
                    }
                });
                request.on('aborted', function() {
                    readStream.unpipe(/** @type {?} */(response));
                    readStream.destroy();
                    if (response) {
                        try {
                            response.end();
                        }
                        catch (e) {
                            console.error('Assertion error during http abort.', e);
                        }
                    }
                });
            }
        };
        request.on('error', function(err) {
            response.writeHead(500, headers.toClient());
            response.end(theme.error500HTML);
        });
        var checkAndSend = function(path, sendGz, decompress) {
            fs.stat(path, function(err, stats) {
                if (err) {
                    if (err.code == 'ENOENT') {
                        if (sendGz) {
                            checkAndSend(path + '.gz', false, path);
                            return;
                        }
                        else {
                            response.writeHead(404, headers.toClient());
                            response.end(theme.error404HTML);
                        }
                    }
                    else {
                        response.writeHead(500);
                        response.end(theme.error500HTML);
                    }
                }
                else if (stats.isDirectory()) {
                    response.writeHead(404);
                    response.end(theme.error404HTML);
                }
                else {
                    doSend(stats, path, decompress);
                }
                err = null;
                stats = null;
                request = null;
            });
        };
        checkAndSend(path, !path.endsWith('.gz') && opt_sendGz, null);
    };


    var resourcesBasePath = [__dirname, 'resources'].join(path.sep) + path.sep;
    var publicBasePath = [__dirname, 'resources', 'htdocs'].join(path.sep) + path.sep;
    aurora.http.BASE = publicBasePath;

    var themeDir = [__dirname, 'resources', 'htdocs', 'themes', config['http']['theme']].join(path.sep) + path.sep;
    var sourceDir = path.resolve(__dirname + path.sep + config['http'].sourceDirectory);
    //Strict-Transport-Security: max-age=31536000
    //config.strictTransportSecurity
    var allRequests = [];
    aurora.http.printPending = function() {
        allRequests.forEach(function(s) {
            if (!s.response['finished'] || (s.response['socket'] && !s.response['socket']['destroyed'])) {
                console.log('pending', s.request.url);
            }
        });
    };

    function httpRequestHandler(request, response) {
        try {
            var newRequests = [];
            allRequests.forEach(function(s) {
                if (!s.response['finished']) {
                    newRequests.push(s);
                }

            });
            if (newRequests.length > 0) {
                console.log('pending requests', newRequests.length);
            }
            allRequests = newRequests;
            var responseHeaders = responseHeadersDef();
            var cookies = {};
            request.headers['cookie'] && request.headers['cookie'].split(';').forEach(function(cookie) {
                var parts = cookie.split('=');
                cookies[parts[0].trim()] = (parts[1] || '').trim();
            });


            var url = path.normalize(decodeURIComponent(request.url));
            var parsedUrl = urlLib.parse(url);
            var exit = false;
            var state = {request: request, cookies: cookies, responseHeaders: responseHeaders, response: response, url: parsedUrl, outUrl: url};
            //            allRequests.push(state);
            callbacks.inOrderTraverse(function(cb) {
                for (var i = 0; i < cb.callbacks.length; i++) {
                    var cur = cb.callbacks[i];
                    if (cur.pattern.test(parsedUrl.pathname)) {
                        var res = cur.callback(state);
                        if (res === false) {
                            exit = true;
                            return true;
                        }
                    }
                }
                return false;
            });
            url = state.outUrl;
            if (exit) {
                return undefined;
            }
            switch (url) {
            case path.sep + 'client.min.js':
                if (config['http']['sourceDirectory'] !== undefined) {
                    responseHeaders.set('X-SourceMap', path.sep + 'client.min.js.map');
                }
                return sendFile(__dirname + path.sep + url, request, response, responseHeaders, true);
            case path.sep + 'LICENSE':
                url = url + '.txt';
            case path.sep + 'LICENSE.txt':
            case path.sep + 'client.js':
            case path.sep + 'client.libs.js':
            case path.sep + 'client.min.js.map':
            case path.sep + 'server.min.js.map':
                return sendFile(__dirname + path.sep + url, request, response, responseHeaders, true);
            case path.sep:
            case '/':
                url += (config['http']['defaultPage'] || 'home');
            default:
                fs.access(publicBasePath + url + '.html', fs.constants.R_OK, function(err) {
                    if (err === null) {
                        fs.readFile(publicBasePath + url + '.html', function(err, pageData) {
                            if (err) {
                                console.error(err);
                                response.writeHead(500, responseHeaders.toClient());
                                response.end(theme.error500HTML);
                                return;
                            }
                            response.writeHead(200, responseHeaders.toClient());
                            response.end(theme.template.replace('{BODY}', pageData.toString()));
                        });
                        return;
                    }
                    fs.access(publicBasePath + url, fs.constants.R_OK, function(err) {
                        if (err && err['code'] === 'ENOENT') {

                            if (config['http']['sourceDirectory'] !== undefined) {
                                fs.access(path.resolve(sourceDir + url), fs.constants.R_OK, function(err) {
                                    if (err && err.code === 'ENOENT') {
                                        response.writeHead(404);
                                        response.end(theme.error404HTML);
                                    }
                                    else {
                                        sendFile(config['http']['sourceDirectory'] + path.sep + url, request, response, responseHeaders);
                                    }
                                });
                                return;
                            }

                            response.writeHead(404);
                            response.end(theme.error404HTML);
                        }
                        else if (err) {
                            response.writeHead(500);
                            response.end(theme.error500HTML);
                            console.log('REQUEST Error ' + request.method + ' ' + request.url + ' ' + request.connection.remoteAddress);
                        }
                        else {
                            sendFile(publicBasePath + url, request, response, responseHeaders);
                        }
                    });
                });
                break;
            }
        }
        catch (e) {
            response.writeHead(500);
            response.end(theme.error500HTML);
            console.log('REQUEST Error ' + request.method + ' ' + url + ' ' + request.connection.remoteAddress);
            console.log(e);
        }
    }

    function shutdownAllServers(servers, done) {
        if (servers.length > 0) {
            servers.pop().server.shutdown(function() {
                shutdownAllServers(servers, done);
            });
        }
        else {
            done();
        }
    }

    function loadTheme(doneCb) {

        fs.readFile(themeDir + 'template.html', function(err, template) {
            theme.template = template.toString();
            fs.readFile(themeDir + 'http403.html', function(err, template403) {
                theme.error403HTML = theme.template.replace('{BODY}', template403.toString());
                fs.readFile(themeDir + 'http404.html', function(err, template404) {
                    theme.error404HTML = theme.template.replace('{BODY}', template404.toString());
                    fs.readFile(themeDir + 'http500.html', function(err, template500) {
                        theme.error500HTML = theme.template.replace('{BODY}', template500.toString());
                        doneCb();
                    });
                });
            });
        });
    }

    var httpServers = {};
    function loadServers() {
        shutdownAllServers(Object.values(httpServers), function() {
            httpServers = {};
            config['http']['servers'].forEach(function(serverConfig) {
                if (serverConfig.port !== undefined) {
                    if (serverConfig.protocol === 'https') {
                        serverConfig['key'] = fs.readFileSync( (serverConfig.key || 'resources/defaultKey.pem'));
                        serverConfig['cert'] = fs.readFileSync((serverConfig.cert || 'resources/defaultCert.pem'));
                        httpServers[serverConfig.port + ''] = /** @type {aurora.http.ConfigServerType} */ ({server: startServer(node_https, serverConfig.port, httpRequestHandler, serverConfig), config: serverConfig});
                        aurora.http.serversUpdatedE.emit(serverConfig.port + '', httpServers[serverConfig.port + '']);
                    }
                    else if (serverConfig.protocol === 'http') {
                        httpServers[serverConfig.port + ''] = /** @type {aurora.http.ConfigServerType} */({server: startServer(node_http, serverConfig.port, httpRequestHandler, serverConfig), config: serverConfig});
                        aurora.http.serversUpdatedE.emit(serverConfig.port + '', httpServers[serverConfig.port + '']);
                    }
                    else {
                        console.error('HTTP Server config entry contains an unsupported protocol.', serverConfig);
                    }
                }
                else {
                    console.error('HTTP Server config entry does not specify a port.', serverConfig);
                }
            });
            aurora.http.serversUpdatedE.emit('update', httpServers);
        });
    }

    /**
     * @param {string} filePath the location of the physical file
     * @param {http.IncomingMessage} request
     * @param {http.ServerResponse} response
     * @param {?} headers
     * @param {string=} opt_filename
     */
    aurora.http.sendFileDownload = function(filePath, request, response, headers, opt_filename) {
        if (opt_filename) {
            headers.set('Content-Disposition', 'attachment;filename=' + path.basename(opt_filename));
        }
        sendFile(filePath, request, response, headers);
    };
    /**
     * @param {RegExp} url
     * @param {string} file
     * @param {function(function(string,string=),?=)|string} sendFileNameCB a callback or a string to get the filename, this may be nessary because you may want to
     * send the modified date or the current date as part of the filename
     */
    aurora.http.sendFileDownloadToURL = function(url, file, sendFileNameCB) {
        var nameCallback = typeof(sendFileNameCB) === 'string' ?
                function(cb1) {
                    cb1(sendFileNameCB, undefined);
                } : sendFileNameCB;

        aurora.http.addMidRequestCallback(url, function(state) {
            nameCallback(function(name, filePath) {
                filePath = filePath || file;
                aurora.http.sendFileDownload(filePath, state.request, state.response, state.responseHeaders, name);
            }, state);
            return false;
        });
    };

    aurora.http.sendDataAsyncDownload = function(request, response, headers, filename) {
        headers.set('Content-Disposition', 'attachment;filename=' + filename);
        request.on('error', function(err) {
            done = true;
            aurora.http.writeError(500, response, headers);
        });

        headers.set('Content-Type', mime.getType(filename));
        headers.set('Accept-Ranges', 'bytes');
        //headers.set('ETag',crypto.createHash('md5').update(data).digest('hex'));

        var gotData = false;
        var done = false;
        return {
            dataCB: function(data) {
                if (done) {
                    return;
                }
                if (!gotData) {
                    response.writeHead(200, headers.toClient());
                }
                gotData = true;
                response.write(data);
            },
            endCB: function(error) {
                if (done) {
                    return;
                }

                done = true;
                if (!gotData && error) {
                    response.writeHead(500);
                }
                response.end();

            }
        };
    };

    aurora.http.writeError = function(code, response, headers) {
        response.writeHead(code, headers);
        if (code === 404) {
            response.writeHead(404);
            response.end(theme.error404HTML);
        }
        else {
            console.error('An unknown error has occured with code ' + code);
            response.end('An unknown error has occured ' + code, 'utf8');
        }
    };

    process.chdir(__dirname);
    config.configE.on('http/theme', loadTheme);
    config.configE.on('http/servers', loadServers);
    loadTheme(function() {
        loadServers();
    });
}());

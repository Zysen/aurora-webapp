goog.provide('aurora.auth.Auth');
goog.provide('aurora.auth.instance');

goog.require('aurora.http');
goog.require('aurora.log');
goog.require('config');
goog.require('recoil.util.Sequence');
goog.require('recoil.util.object');
/**
 * @constructor
 * @param {aurora.auth.Auth} auth
 */
aurora.auth.SessionTable = function(auth) {
    this.log_ = aurora.log.createModule('AUTH');
    this.auth_ = auth;
    this.expireSessionsWithClients_ = false;
    var me = this;
    var compareSession = function(x, y) {
        return recoil.util.object.compare([x.token, x.seriesId], [y.token, y.seriesId]);
    };

    var hasClient = function(s) {
        for (var k in s.clients) {
            return true;
        }
        return false;
    };
    this.compareExpiry_ = function(x, y) {
        if (x.expiry === null && y.expiry === null) {
            return compareSession(x, y);
        }
        if (x.expiry === null) {
            return 1;
        }
        if (y.expiry === null) {
            return -1;
        }

        if (!me.expireSessionsWithClients_) {
            var xClients = hasClient(x);
            var yClients = hasClient(y);

            if (xClients != yClients) {
                if (xClients) {
                    return 1;
                }
                return -1;
            }
        }
        var res = x.expiry - y.expiry;

        if (res === 0) {
            return compareSession(x, y);
        }
        return res;
    };
    /**
     * @private
     * @type {goog.structs.AvlTree<!aurora.auth.SessionTable.Entry>}
     */
    this.expiry_ = new goog.structs.AvlTree(this.compareExpiry_);
    this.table_ = {};
    this.clients_ = {};
    /**
     * @private
     * @type {!Object<string,string>}
     */
    this.internalTokens_ = {};

};

/**
 */
aurora.auth.SessionTable.prototype.print = function () {
    console.log("Session table");
    for (var k in this.table_) {
        console.log(k + " -> ", this.table_[k]);
    }
};
/**
 * @typedef {?}
 */
aurora.auth.SessionTable.ClientEntry;

/**
 * @typedef {{clients:Object<string,aurora.auth.SessionTable.ClientEntry>, token:string, constToken:string, seriesId:!string, expiry:?number, timeout:?number,data:Object}}
 */
aurora.auth.SessionTable.Entry;
/**
 * @private
 * @param {string|undefined} token
 * @param {string=} opt_seriesId
 * @return {undefined|aurora.auth.SessionTable.Entry}
 */
aurora.auth.SessionTable.prototype.findSessions_ = function(token, opt_seriesId) {
    var v = this.table_[token];

    if (v === undefined || (opt_seriesId !== undefined && v.seriesId !== opt_seriesId)) {
        return undefined;
    }
    return v;
};

/**
 * @param {string} clientId
 * @return {string}
 */
aurora.auth.SessionTable.prototype.getClientToken = function(clientId) {
    return (this.clients_[clientId] || {}).constToken;
};


/**
 * gets a constant token from token that is in the cookie
 *
 * @param {string} token
 * @return {?string}
 */
aurora.auth.SessionTable.prototype.getToken = function(token) {
    var session = this.findSessions_(token);
    if (session) {
        return session.constToken;
    }
    return null;
};
/**
 * @param {string} token
 * @return {string}
 */
aurora.auth.SessionTable.prototype.getInternalToken = function(token) {
    return this.internalTokens_[token];
};

/**
 * @param {string} clientId
 */
aurora.auth.SessionTable.prototype.unregisterClientToken = function(clientId) {
    var info = this.clients_[clientId];
    if (info) {
        delete this.clients_[clientId];
        var session = this.findSessions_(info.token);
        if (session) {
            this.updateSession_(session, function() {
                delete session.clients[clientId];
            });
        }
    }
};
/**
 * @param {?} request
 * @param {string} clientId
 * @param {?} connection
 * @return {boolean}
 */
aurora.auth.SessionTable.prototype.registerClientToken = function(request, clientId, connection) {

    var cookies = {};

    (request['cookies'] || []).forEach(function(v) {
        cookies[v['name']] = v['value'];
    });
    var sesh = cookies['sesh'];
    if (sesh) {
        sesh = decodeURIComponent(sesh).split('-');
        if (sesh.length === 2) {
            var token = sesh[0];
            var seriesId = sesh[1];
            var session = this.findSessions_(token, seriesId);
            if (session) {
                this.clients_[clientId] = {token: token, constToken: session.constToken};
                this.updateSession_(session, function() {
                    session.clients[clientId] = {};
                });

                return true;
            }
            else if (this.removeSeriesId(seriesId)) {
                this.log_.warn('Token Theft Assumed!!!, Deleting all tokens that relate to this seriesId');
            }
            else {
                //                    connection.sendUTF(JSON.stringify({command: AURORA.COMMANDS.AUTH.TOKEN_INVALID}));   //Legitimate Old Token Attempt
            }

        }
    }
    return false;

};

/**
 * wrapper to ensure expiry is updated when session is updated
 * do not update expiry in the callback
 * @private
 * @param {!aurora.auth.SessionTable.Entry} session
 * @param {function()} cb
 */
aurora.auth.SessionTable.prototype.updateSession_ = function(session, cb) {
    if (session.expiry !== null) {
        this.expiry_.remove(session);
    }
    cb();

    if (session.expiry !== null) {
        session.expiry = process.hrtime()[0] * 1000 + session.timeout;
        this.expiry_.add(session);
    }
    this.updateExpire_();
};

/**
 * @param {string|undefined} seriesId
 * @return {boolean} true if any removed
 */

aurora.auth.SessionTable.prototype.removeSeriesId = function(seriesId) {
    var toRemove = [];
    for (var k in this.table_) {
        if (this.table_[k].seriesId === seriesId) {
            toRemove.push(k);
        }
    }
    var me = this;
    toRemove.forEach(function(t) {
        me.remove(t);
    });
    this.updateExpire_();
    return toRemove.length > 0;
};
/**
 * @param {string} token
 * @param {string} seriesId
 * @param {string} constToken
 * @param {?number} timeout
 * @param {Object} data
 */
aurora.auth.SessionTable.prototype.createSession = function(token, seriesId, constToken, timeout, data) {
    var exp = timeout === null ? null : (process.hrtime()[0] * 1000 + timeout);
    var session = {expiry: exp, token: token, constToken: constToken, seriesId: seriesId, data: data, timeout: timeout, clients: {}};
    this.expiry_.add(session);
    this.table_[token] = session;
    this.internalTokens_[constToken] = token;
    this.updateExpire_();
};


/**
 * @param {string|undefined} clientId
 * @return {boolean}
 */
aurora.auth.SessionTable.prototype.validClient = function(clientId) {
    return this.clients_[clientId] !== undefined;
};
/**
 * @param {string|undefined} token
 */
aurora.auth.SessionTable.prototype.remove = function(token) {
    if (!token) {
        return;
    }
    var session = this.table_[token];
    if (session) {
        var me = this;
        this.auth_.logout_(token);
        delete this.table_[token];
        delete this.internalTokens_[session.constToken];
        this.expiry_.remove(session);
        for (var cid in session.clients) {
            delete me.clients_[cid];
        }
        this.updateExpire_();
    }
};

/**
 * @private
 * @param {string|undefined} token
 * @param {string|undefined} seriesId
 * @param {string} clientId
 * @return {{connection:?}|undefined}
 */
aurora.auth.SessionTable.prototype.findSession_ = function(token, seriesId, clientId) {
    var sessions = this.findSessions_(token, seriesId);
    if (sessions) {
        return sessions.clients[clientId];
    }
    return undefined;
};


/**
 * @private
 * updates the sessions and it expires later
 * @param {string|undefined} token
 */

aurora.auth.SessionTable.prototype.touch_ = function(token) {
    var sessions = this.findSessions_(token);
    if (sessions && sessions.expiry !== null) {
        this.updateSession_(sessions, function() {});
    }
};

/**
 * expires all sessions past there expiry time
 */
aurora.auth.SessionTable.prototype.expire = function() {
    var now = process.hrtime()[0] * 1000;
    var me = this;
    var toRemove = [];
    this.expiry_.inOrderTraverse(function(s) {
        if (s.expiry <= now) {
            if (!me.expireSessionsWithClients_) {
                for (var k in s.clients) {
                    return true;
                }
            }
            toRemove.push(s.token);
            return false;
        }
        return true;
    });
    toRemove.forEach(function(t) {
        me.remove(t);
    });

    this.updateExpire_();
};


/**
 * @param {boolean} val
 */
aurora.auth.SessionTable.prototype.setSessionExpiresWithClient = function(val) {
    if (this.expireSessionsWithClients_ === val) {
        var old = this.expiry_;
        var me = this;
        this.expireSessionsWithClients_ = val;
        this.expiry_ = new goog.structs.AvlTree(this.compareExpiry_);
        old.inOrderTraverse(function(v) {
            me.expiry_.add(v);
        });
        this.updateExpire_();
    }
};

/**
 * @private
 * set the callback to check the next expiry time
 */
aurora.auth.SessionTable.prototype.updateExpire_ = function() {
    var now = process.hrtime()[0] * 1000;
    var toRemove = [];
    var me = this;
    if (me.nextExpire_) {
        clearTimeout(me.nextExpire_);
        this.nextExpire_ = null;
    }

    var curTime = process.hrtime()[0] * 1000;
    this.expiry_.inOrderTraverse(function(s) {

        if (s.expiry !== null) {
            if (!me.expireSessionsWithClients_) {
                for (var k in s.clients) {
                    return true;
                }
            }
            me.nextExpire_ = setTimeout(function() {
                me.nextExpire_ = null;
                me.expire();
            }, Math.max(1, 1 + s.expiry - curTime));
        }
        return true;
    });

};
/**
 * @typedef {{validate:function(string, Object,Object, function(string)), unregister:function(string), getCredentials:?function(aurora.http.RequestState,function (?)):?}}
 */
aurora.auth.Authenticator;

/**
 * @export
 * @constructor
 */
aurora.auth.Auth = function() {
    this.sessions_ = new aurora.auth.SessionTable(this);
    this.crypto_ = require('crypto');
    this.nextToken_ = new recoil.util.Sequence();
    this.blockAutoLogin_ = null;
    /**
     * @private
     * @param {aurora.http.RequestState} state
     */
    this.loginPageCb_ = function(state) {
        state.response.writeHead(403, state.responseHeaders.toClient());
        state.response.write('<html><head><title>Access Denied</title></head><body>Access Denied Please log in</body></html>');
        state.response.end();
    };

    /**
     * @private
     * @type {!Array<!aurora.auth.Authenticator>}
     */
    this.authenticators_ = [];
    this.allowedUrls_ = {'/client.js': true, 'client.libs.js': true, 'client.min.js.map': true, 'client.min.js': true};
    this.allowedPrefixes_ = [/^public\//];
    this.activeSessionExpiry_ = 120000;//30000;  //120000===2 minutes         //3600000 === An hour   //How long an http session lasts

    var me = this;
    aurora.http.addPreRequestCallback(/.*/, function(state) {   //Enforce login page when not authenticated.
        var request = state.request;
        var response = state.response;
        if (state.url.pathname === '/logout') {
            let sesh = decodeURIComponent(state.cookies['sesh'] || '').split('-');
            let token = sesh.length == 2 ? sesh[0] : undefined;
            let seriesId = sesh.length == 2 ? sesh[1] : undefined;
            let session = seriesId ? me.sessions_.findSessions_(token, seriesId) : undefined;
            if (session) {
                me.sessions_.remove(token);
                var referer = state.request.headers['referer'];
                if (referer) {
                    try {
                        state.response.writeHead(302, {'Location': referer});
                        state.response.end();
                        return false;
                    }
                    catch (e) {

                    }
                }
                me.loginPageCb_(state);

                return false;
            }
            // logout
        }

        if (me.allowedUrls_[state.url.pathname]) {return undefined;}
        for (var index = 0; index < me.allowedPrefixes_.length; index++) {
            if (me.allowedPrefixes_[index].test(state.url.pathname)) {
                return undefined;
            }
        }
        //first extract the token and series id
        var sesh = decodeURIComponent(state.cookies['sesh'] || '').split('-');

        var token = sesh.length == 2 ? sesh[0] : undefined;
        var seriesId = sesh.length == 2 ? sesh[1] : undefined;
        var session = seriesId ? me.sessions_.findSessions_(token, seriesId) : undefined;
        if (session) {
            state.token = session.constToken;
            me.sessions_.touch_(token);
            return undefined;
        }

        session = seriesId ? me.sessions_.findSessions_(token, seriesId) : undefined;
        if (session) {
            // possible attack
            me.sessions_.removeSeriesId(seriesId);
        }

        session = me.sessions_.findSessions_(token);
        if (session) {
            me.sessions_.remove(token);
        }
        var doLogin = function(credentials) {

            // if credentials already have a token that means we just want to login from a different ip
            var tokenInfo = credentials.token ? credentials.token : me.generateToken();
            // update  cookies so that the have the new token
            state.responseHeaders.set('Set-Cookie', [
                'sesh=' + encodeURIComponent(tokenInfo.token + '-' + tokenInfo.seriesId) + '; Path=/;']);
            if (credentials.token) {
                if (credentials.token.token === '') {
                    credentials.response({message: 'no token given'}, state);
                }
                // if the autologin is blocked autologin will just look like the login failed but all it will do is extend block
                else if (!this.blockAutoLogin_ && me.sessions_.findSessions_(credentials.token.token, credentials.token.seriesId)) {
                    credentials.response(null, state);
                }
                else {
                    // wait 5 minutes before we can do another password login from that ip
                    if (me.blockAutoLogin_) {
                        clearTimeout(me.blockAutoLogin_);
                    }
                    me.blockAutoLogin_ = setTimeout(function () {
                        me.blockAutoLogin_ = null;
                    }, 5*60000);
                }
            }
            else {
                me.login(tokenInfo.token, tokenInfo.seriesId, credentials.remember, credentials, state);
            }
        };
        var credentials = me.getCredentials(state, doLogin);
        if (credentials !== null) {
            if (credentials) {
                doLogin(credentials);
                return credentials.result;
            }
            return false;

        }
        me.loginPageCb_(state);
        return false;
    });
};

/**
 * @param {string} cookies
 * @return {?{token:string,seriesId:string}}
 */
aurora.auth.Auth.getSessionFromCookies = function(cookies) {
    if (!cookies) {
        return null;
    }
    
    var parts = cookies.split(";");
    for (var i =0 ; i < parts.length; i++) {
        var cookie = parts[i].trim();
        if (cookie.startsWith('sesh=')) {
            var sessParts = cookie.split('=');
            if (sessParts.length > 1) {
                return aurora.auth.Auth.parseSessionToken(sessParts[1]);
            }
        }
    }
    return null;
};

/**
 * @param {string} token
 * @return {?{token:string,seriesId:string}}
 */
aurora.auth.Auth.parseSessionToken = function(token) {
    if (token) {
        var parts = token.split('-');
        if (parts.length === 2) {
            return {token: parts[0], seriesId : parts[1]};
        }
    }
    return null;
};

/**
 * @param {number} timeout
 */
aurora.auth.Auth.prototype.setSessionExpiryMs = function(timeout) {
    this.activeSessionExpiry_ = timeout;
};

/**
 * @param {boolean} val
 */
aurora.auth.Auth.prototype.setSessionExpiresWithClient = function(val) {
    this.sessions_.setSessionExpiresWithClient(val);
};

/**
 * @param {!aurora.auth.Authenticator} auth
 */
aurora.auth.Auth.prototype.addAuthenticator = function(auth) {
    this.authenticators_.push(auth);
};
/**
 * allows athenticator to get credentals out of the http
 * request themselves this means it is total generic how the login is works
 * @param {aurora.http.RequestState} state
 * @param {function (?)} cb
 * @return {?}
 */
aurora.auth.Auth.prototype.getCredentials = function(state, cb) {
    if (this.authenticators_.length === 0) {
        return {remember: false, result: undefined, response: function() {}};
    }

    for (var i = 0; i < this.authenticators_.length; i++) {
        var auth = this.authenticators_[i];
        if (auth.getCredentials) {
            var cred = auth.getCredentials(state, cb);
            if (cred !== null) {
                return cred;
            }
        }
    }

    return null;
};

/**
 * add urls that are always allowed
 * @param {string|RegExp} pattern if pattern is string then it is a prefix otherwize it must match the expression
 *
 */
aurora.auth.Auth.prototype.addAllowedExp = function(pattern) {
    if (typeof(pattern) === 'string') {
        this.allowedPrefixes_.push(new RegExp('^' + aurora.http.escapeRegExp(pattern)));
    }
    else {
        this.allowedPrefixes_.push(pattern);
    }
};
/**
 * @param {function(aurora.http.RequestState)} cb
 */
aurora.auth.Auth.prototype.setLoginPage = function(cb) {
    this.loginPageCb_ = cb;
};

/**
 * @param {string} token
 * @param {string} seriesId
 * @param {boolean} rememberMe
 * @param {Object} credentials
 * @param {aurora.http.RequestState} state
 **/
aurora.auth.Auth.prototype.login = function(token, seriesId, rememberMe, credentials, state) {

    // check to see if the token exists if not
    var res = {token: token, seriesId: seriesId};
    var row = undefined;
    var data = {};
    var todo = {};
    var me = this;
    var constToken = this.nextToken_.next();
    var doAuth = function(i) {
        if (i >= me.authenticators_.length) {
            me.sessions_.createSession(token, seriesId, constToken, rememberMe ? null : me.activeSessionExpiry_, data);
            credentials.response(null, state);
            return;
        }
        var auth = me.authenticators_[i];

        auth.validate(constToken, credentials, data, function(message) {
            if (message) {
                // the authentication failed unregister all the successful authentications;
                for (var j = i - 1; j >= 0; j--) {
                    me.authenticators_[j].unregister(constToken);
                }
                credentials.response(message, state);
            } else {
                doAuth(i + 1);
            }

        });
    };

    doAuth(0);

};

/**
 * @param {string} token
 * @return {Object}
 */
aurora.auth.Auth.prototype.getSessionData = function(token) {
    var session = this.sessions_.findSessions_(this.sessions_.getInternalToken(token));
    if (session) {
        return session.data;
    }
    return null;
};
/**
 * @private
 * @param {string} token
 */
aurora.auth.Auth.prototype.logout_ = function(token) {
    var session = this.sessions_.findSessions_(token);
    if (session) {
        for (var j = this.authenticators_.length - 1; j >= 0; j--) {
            this.authenticators_[j].unregister(session.constToken);
        }
        var allClients = function(token) {
            return function(con, curToken) {return curToken === token;};
        };
//        this.serverLogoutChannelE_.send("logout", undefined ,allClients(session.constToken));
    }
};


/**
 * @param {string} token this is an external token (constToken);
 */
aurora.auth.Auth.prototype.forceLogout = function(token) {
    var internalToken = this.sessions_.getInternalToken(token);
    this.sessions_.remove(internalToken);
};


/**
 * @param {string} clientId
 * @return {string}
 */
aurora.auth.Auth.prototype.getClientToken = function(clientId) {
    return this.sessions_.getClientToken(clientId);
};


/**
 * @private
 * @param {string} token
 * @return {string}
 */
aurora.auth.Auth.prototype.getInternalToken_ = function(token) {
    return this.sessions_.getInternalToken(token);
};


/**
 * gets a constant token from token that is in the cookie
 *
 * @param {string} token
 * @return {?string}
 */
aurora.auth.Auth.prototype.getToken = function(token) {
    return this.sessions_.getToken(token);
};

/**
 * @param {?} request
 * @param {string} clientId
 * @param {?} connection
 * @return {boolean}
 */
aurora.auth.Auth.prototype.registerClientToken = function(request, clientId, connection) {
    return this.sessions_.registerClientToken(request, clientId, connection);

};

/**
 * @param {string|undefined} clientId
 * @return {boolean}
 */
aurora.auth.Auth.prototype.validClient = function(clientId) {
    return this.sessions_.validClient(clientId);
};
/**
 * @param {string} clientId
 */
aurora.auth.Auth.prototype.unregisterClientToken = function(clientId) {
    this.sessions_.unregisterClientToken(clientId);
};

/**
 * call this to extend the lifetime of aseesion
 * I am not sure this works yet it seems to me we should use an constant token
 * and we don't seem to use the series id but probably should
 * @param {string} token
 * @param {string} seriesId
 */
aurora.auth.Auth.prototype.keepAlive = function(token, seriesId) {
    this.sessions_.touch_(token);
};

/**
 * @return {{token:string, seriesId:string}}
 */
aurora.auth.Auth.prototype.generateToken = function() {
    return {token: this.crypto_.randomBytes(10).toString('hex'), seriesId: this.crypto_.randomBytes(10).toString('hex')};
};

/**
 * @final
 * @type {!aurora.auth.Auth}
 */
aurora.auth.instance = new aurora.auth.Auth();

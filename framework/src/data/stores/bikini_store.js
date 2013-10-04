
M.BikiniStore = M.Store.extend({

    _type: 'M.BikiniStore',

    _transactionFailed: false,

    _selector: null,

    name: 'bikini',

    endpoints: {},

    version: '1.2',

    options: null,

    msgStore:  null,

    messages:  null,

    useLocalStore: true,

    useSocketNotify: true,

    useOfflineChanges: true,

    typeMapping: {
        'binary':  'text',
        'date':    'string'
    },

    initialize: function( options ) {
        M.Store.prototype.initialize.apply(this, arguments);
        this.options = {
            useLocalStore:      this.useLocalStore,
            useSocketNotify:    this.useSocketNotify,
            useOfflineChanges:  this.useOfflineChanges,
            socketPath:         this.socketPath
        };
        _.extend(this.options, options || {});
    },

    initModel: function( model ) {
    },

    initCollection: function( collection ) {
        var url    = collection.getUrlRoot();
        var entity = this.getEntity(collection.entity);
        if (url && entity) {
            var name    = entity.name;
            var hash    = this._hashCode(url);
            var channel = name + hash;
            collection.channel = channel;
            // get or create endpoint for this url
            var endpoint   = this.endpoints[hash];
            if (!endpoint) {
                endpoint = {};
                endpoint.url         = url;
                endpoint.entity      = entity;
                endpoint.channel     = channel;
                endpoint.credentials = entity.credentials || collection.credentials;
                endpoint.localStore  = this.createLocalStore(endpoint);
                endpoint.messages    = this.createMsgCollection(endpoint);
                endpoint.socket      = this.createSocket(endpoint, collection);
                endpoint.info        = this.fetchServerInfo(endpoint);
                this.endpoints[hash] = endpoint;
            }
            collection.endpoint   = endpoint;
            collection.localStore = endpoint.localStore;
            collection.messages   = endpoint.messages;
            collection.listenTo(this, channel, this.onMessage, collection);

            if (endpoint.messages && !endpoint.socket) {
                this.sendMessages(endpoint, collection);
            }
        }
    },

    getEndpoint: function(url) {
        if (url) {
            var hash = this._hashCode(url);
            return this.endpoints[hash];
        }
    },

    createLocalStore: function(endpoint) {
        if (this.options.useLocalStore && endpoint) {
            var entities = {};
            entities[endpoint.entity.name] = {
                name: endpoint.channel
            };
            return new M.LocalStorageStore({
                entities: entities
            });
        }
    },

    createMsgCollection: function(endpoint) {
        if (this.options.useOfflineChange && endpoint) {
            var name = "msg-" + endpoint.channel;
            var MsgCollection = M.Collection.extend({
                model: M.Model.extend({ idAttribute: '_id' })
            });
            var messages  = new MsgCollection({
                entity: name,
                store: new M.LocalStorageStore()
            });
            messages.fetch();
            return messages;
        }
    },

    createSocket: function(endpoint, collection) {
        if (this.options.useSocketNotify && this.options.socketPath && endpoint) {
            var url = M.Request.getLocation(endpoint.url);
            var host = url.protocol + "//" +url.host;
            var path = url.pathname;
            var path = this.options.socketPath || (path + (path.charAt(path.length-1) === '/' ? '' : '/' ) + 'live');
            // remove leading /
            var resource = (path && path.indexOf('/') == 0) ? path.substr(1) : path;
            var that = this;
            var socket = M.SocketIO.create({
                host: host,
                resource: resource,
                connected: function() {
                    that._bindChannel(socket, endpoint);
                    that.sendMessages(endpoint, collection);
                }
            });
            return socket;
        }
    },

    _bindChannel: function(socket, endpoint) {
        var that = this;
        var channel = endpoint.channel;
        var name    = endpoint.entity.name;
        var time = this.getLastMessageTime(channel);
        socket.on(channel, function(msg) {
            if (msg) {
                that.setLastMessageTime(channel, msg.time);
                that.trigger(channel, msg);
            }
        });
        socket.emit('bind', {
            entity:  name,
            channel: channel,
            time:    time
        });
    },

    getLastMessageTime: function(channel) {
        return localStorage.getItem('__'+ channel + 'last_msg_time') || 0;
    },

    setLastMessageTime: function(channel, time) {
        if (time) {
            localStorage.setItem('__'+ channel + 'last_msg_time', time);
        }
    },

    _hashCode: function(str){
        var hash = 0, i, char;
        if (str.length == 0) return hash;
        for (i = 0, l = str.length; i < l; i++) {
            char  = str.charCodeAt(i);
            hash  = ((hash<<5)-hash)+char;
            hash |= 0; // Convert to 32bit integer
        }
        return hash;
    },


    onMessage: function(msg) {
        if (msg && msg.method) {
            var options = { store: this.localStore, merge: true, fromMessage: true, entity: this.entity.name };
            var attrs   = msg.data;
            switch(msg.method) {
                case 'patch':
                    options.patch = true;
                case 'update':
                case 'create':
                    var model = msg.id ? this.get(msg.id) : null;
                    if (model) {
                        model.save(attrs, options);
                    } else {
                        this.create(attrs, options);
                    }
                    break;

                case 'delete':
                    if (msg.id) {
                        if (msg.id === 'all') {
                            this.reset();
                        } else {
                            var model = this.get(msg.id);
                            if (model) {
                                model.destroy(options);
                            }
                        }
                    }
                    break;

                default:
                    break;
            }
        }
    },

    sync: function(method, model, options) {
        var that   = options.store || this.store;
        if (options.fromMessage) {
            return that.handleCallback(options.success);
        }
        var endpoint = that.getEndpoint(this.getUrlRoot());
        if (that && endpoint) {
            var channel = this.channel;

            if ( M.isModel(model) && !model.id) {
                model.set(model.idAttribute, new M.ObjectID().toHexString());
            }

            var time = that.getLastMessageTime(channel);
            // only send read messages if no other store can do this
            // or for initial load
            if (method !== "read" || !this.localStore || !time) {
                // do backbone rest
                that.addMessage(method, model,
                    this.localStore ? {} : options, // we don't need to call callbacks if an other store handle this
                    endpoint);
            } else if (method == "read" && time) {
                that.fetchChanges(endpoint, time);
            }
            if (endpoint.localStore) {
                options.store  = endpoint.localStore;
                endpoint.localStore.sync.apply(this, arguments);
            }
        }
    },

    addMessage: function(method, model, options, endpoint) {
        var that = this;
        if (method && model) {
            var changes = model.changedSinceSync;
            var data = null;
            var storeMsg = false;
            switch (method) {
                case 'update':
                case 'create':
                    data  = model.attributes;
                    storeMsg = true;
                    break;
                case 'patch':
                    if ( _.isEmpty(changes)) return;
                    data = changes;
                    storeMsg = true;
                    break;
                case 'delete':
                    storeMsg = true;
                    break;
            }
            var msg = {
                _id: model.id,
                id: model.id,
                method: method,
                data: data
            };
            var emit = function(endpoint, msg) {
                that.emitMessage(endpoint, msg, options, model);
            };
            if (storeMsg) {
                this.storeMessage(endpoint, msg, emit);
            } else {
                emit(endpoint, msg);
            }
        }
    },

    emitMessage: function(endpoint, msg, options, model) {
        var channel = endpoint.channel;
        var that = this;
        var url   = endpoint.url;
        if (msg.id && msg.method !== 'create') {
            url += "/" + msg.id;
        }
        Backbone.sync(msg.method, model, {
            url: url,
            error: function(xhr, status) {
                if (!xhr.responseText && that.options.useOfflineChange) {
                    // this seams to be only a connection problem, so we keep the message an call success
                    that.handleCallback(options.success, msg.data);
                } else {
                    that.removeMessage(endpoint, msg, function(endpoint, msg) {
                        // Todo: revert changed data
                        that.handleCallback(options.error, status);
                    });
                }
            },
            success: function(data) {
                that.removeMessage(endpoint, msg, function(endpoint, msg) {
                    if (options.success) {
                        var resp = data;
                        that.handleCallback(options.success, resp);
                    } else {
                        // that.setLastMessageTime(channel, msg.time);
                        if (msg.method === 'read') {
                            var array = _.isArray(data) ? data : [ data ];
                            for (var i=0; i < array.length; i++) {
                                data = array[i];
                                if (data) {
                                    that.trigger(channel, {
                                        id: data._id,
                                        method: 'update',
                                        data: data
                                    });
                                    //that.setLastMessageTime(channel, msg.time);
                                }
                            }
                        } else {
                            that.trigger(channel, msg);
                        }
                    }
                });
            },
            beforeSend: function(xhr) {
                M.Request.setAuthentication(xhr, endpoint.credentials);
            }
        });
    },

    fetchChanges: function(endpoint, time) {
        var that = this;
        if (endpoint && endpoint.url && time) {
            var changes = new M.Collection();
            changes.fetch({
                url: endpoint.url + '/changes/' + time,
                success: function() {
                   changes.each( function(msg) {
                       if (msg.time && msg.method) {
                           that.setLastMessageTime(endpoint.channel, msg.time);
                           that.trigger(endpoint.channel, msg);
                       }
                   });
                }
            });
        }
    },

    fetchServerInfo: function(endpoint) {
        var that = this;
        if (endpoint && endpoint.url) {
            var info = new M.Model();
            var time = that.getLastMessageTime(endpoint.channel);
            info.fetch({
                url: endpoint. url + "/info",
                success: function() {
                    if (!time && info.get('time')) {
                        that.setLastMessageTime(endpoint.channel, info.get('time'));
                    }
                    if (!that.options.socketPath && info.get('socketPath')) {
                        that.options.socketPath = info.get('socketPath');
                        if (that.options.useSocketNotify) {
                            that.createSocket(endpoint, endpoint.messages)
                        }
                    }
                }
            });
        }
    },

    sendMessages: function(endpoint, collection) {
        if (endpoint && endpoint.messages && collection) {
            var that = this;
            endpoint.messages.each( function(message) {
                var msg;
                try { msg = JSON.parse(message.get('msg')) } catch(e) {};
                var channel  = message.get('channel');
                if (msg && channel) {
                    var model = that.createModel({ collection: collection }, msg.data);
                    that.emitMessage(endpoint, msg, {}, model);
                } else {
                    message.destroy();
                }
            });
        }
    },

    mergeMessages: function(data, id) {
        return data;
    },

    storeMessage: function(endpoint, msg, callback) {
        if (endpoint && endpoint.messages && msg) {
            var channel = endpoint.channel;
            var message = endpoint.messages.get(msg._id);
            if (message) {
                var oldMsg = JSON.parse(message.get('msg'));
                message.save({
                    msg: JSON.stringify(_.extend(oldMsg, msg))
                });
            } else {
                endpoint.messages.create({
                    _id: msg._id,
                    id:  msg.id,
                    msg: JSON.stringify(msg),
                    channel: channel
                });
            }
        }
        callback(endpoint, msg);
    },

    removeMessage: function(endpoint, msg, callback) {
        if (endpoint && endpoint.messages) {
            var message = endpoint.messages.get(msg._id);
            if (message) {
                message.destroy();
            }
        }
        callback(endpoint, msg);
    }
});
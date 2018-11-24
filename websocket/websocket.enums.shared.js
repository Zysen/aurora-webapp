goog.provide('aurora.websocket.enums');

/**
 * Enum for channel message data type.
 * @enum {number}
 */
aurora.websocket.enums.types = {
    BINARY: 0,
    STRING: 1,
    OBJECT: 2,
    BOOLEAN: 3,        //TODO: Implement me
    NUMBER: 4        //TODO: Implement me
};

/**
 * @const
 */
aurora.websocket.PLUGIN_ID = 'websocket';

/**
 * @const
 * @enum {number}
 */
aurora.websocket.error = {
    NO_SESSION : -1
};

/**
 * Enum for channel management message aurora.websocket.types.
 * @enum {number}
 */
aurora.websocket.enums.COMMANDS = {
    REGISTER: 0,
    UNREGISTER: 1
};

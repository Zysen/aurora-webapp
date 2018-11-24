goog.provide('skeleton.channels');

goog.require('aurora.websocket');
goog.require('skeleton');

/**
 * @export
*/
skeleton.channels = {};
(function() {
    var myChannel = aurora.websocket.getChannel(skeleton.PLUGIN_NAME, skeleton.CHANNELS.TEST_CHANNEL, function(packet) {
        myChannel.send(packet.data);
    });
}());

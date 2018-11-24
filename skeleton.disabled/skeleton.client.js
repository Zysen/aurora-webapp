goog.provide('aurora.widgets.Skeleton2');
goog.require('aurora.websocket');
goog.require('aurora.widgets');
goog.require('skeleton');

//goog.require("F.tables");
/**
 * @constructor
 * @export
 * @param {number} id Id unique to this widget instance.
 * @param {Object} args Arguments from html definition
 * @implements {aurora.Widget}
 */
aurora.widgets.Skeleton2 = function(id, args) {
    var container = document.createElement('div');
    container.innerHTML = 'Skeleton Widget';
    var buttonElement = document.createElement('button');
    buttonElement.innerHTML = 'Click';
    container.appendChild(buttonElement);

    this.build = function() {
        return container;
    };
    this.load = function() {
        var myChannel = aurora.websocket.getChannel(skeleton.PLUGIN_NAME, skeleton.CHANNELS.TEST_CHANNEL, function(packet) {
            console.log(packet.data);
        });

        buttonElement.onclick = function() {
            myChannel.send({
                message: 'Client Message'
            });
        };

        //var tableW = new F.tables.tableWidget();
    };
    this.destroy = function() {

    };
};
aurora.widgets.register('Skeleton', aurora.widgets.Skeleton2);

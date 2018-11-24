goog.provide('aurora.widgets');
goog.require('aurora.websocket');

/**
 * Widget
 * @interface
 */
aurora.Widget = function() {};
/**
 * build the widget
 */
aurora.Widget.prototype.build = function() {};
/**
 * load the widget
 */
aurora.Widget.prototype.load = function() {};
/**
 * remove the widget
 */
aurora.Widget.prototype.destroy = function() {};

/**
 @export
 */
aurora.widgets = (function() {
    var widgetRegister = {};
    var widgetInstances = {};

    function domParse(html) {
        var element = document.createElement('div');
        element.innerHTML = html;
        return element.children;
    };

    function inflateWidgets(element) {
        if (element.className != undefined && typeof(element.className) === 'string' && element.className.startsWith('widget_')) {
            var widget_name = element.className.replace('widget_', '');
            if (widgetRegister[widget_name] === undefined) {
                //console.log("Cannot find widget definition for "+widget_name);
                return false;
            }
            if (widgetInstances[widget_name] === undefined) {
                widgetInstances[widget_name] = [];
            }
            var args = {};
            if (element.title != undefined && element.title.length > 0) {
                try {args = JSON.parse(element.title.replaceAll("'", '"'));}
                catch (e) {console.log('Unable to parse JSON from widget title arguments');console.log(e);}
            }
            var instanceId = widgetInstances[widget_name].length;
            var newWidget = new widgetRegister[widget_name](instanceId, args);

            var wBuild = newWidget.build();
            if (!wBuild) {
                wBuild = document.createElement('span');
            }
            var elementParent = element.parentNode;
            if (typeof(wBuild) == 'string') {
                elementParent.replaceChild(domParse('<div>' + wBuild + '</div>')[0], element);
            }else {
                elementParent.replaceChild(wBuild, element);
            }
            widgetInstances[widget_name].push({instanceId: instanceId, widget_name: widget_name, element: elementParent, widget: newWidget, widgetDef: widgetRegister[widget_name]});
        }
        for (var i = 0; i < element.children.length; i++) {
            inflateWidgets(element.children[i]);
        }
    };

    window.addEventListener('load', function() {
        inflateWidgets(document.body);
    }, false);

    aurora.websocket.onReady(function() {
        inflateWidgets(document.body);
        for (var widgetName in widgetInstances) {
            widgetInstances[widgetName].forEach(function(widgetOb) {
                widgetOb.widget.load();
            });
        }
    });

    return {
        register: function(name, widgetConstructor) {
            widgetRegister[name] = widgetConstructor;
        }
    };
}());




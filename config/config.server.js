goog.provide('config');
goog.require('aurora.object');

config = (function() {
    const fs = require('fs');
    const EventEmitter = require('events').EventEmitter;

    var configFilePath = __dirname + '/config.json';
    var pub = JSON.parse(fs.readFileSync(configFilePath).toString());
    pub.configE = new EventEmitter();

    var lastConfig = JSON.parse(fs.readFileSync(configFilePath).toString());

    fs.watchFile(configFilePath, {interval: 500, persistent: true}, function(curr, prev) {
        fs.readFile(configFilePath, function(err, configFile) {
            try {
                var newConfig = JSON.parse(configFile.toString());
                for (var index in newConfig) {
                    pub[index] = newConfig[index];
                }
                aurora.object.deepDiff(new Object(lastConfig), new Object(newConfig)).forEach(function(diff) {
                    pub.configE.emit(diff.path.join('/'), diff, true);
                });
                lastConfig = newConfig;
                
                if (newConfig.aurora && newConfig.aurora.title !== undefined) {
                    process.title = config.aurora.title;
                }
            }
            catch (e) {
                console.error("error reading config file", e);
            }
        });
    });
    return pub;
}());

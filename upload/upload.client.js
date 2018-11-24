goog.provide('aurora.Upload');

/**
 * @constructor
 * @param {{type:string, url:string, data:Object, dataType:(undefined|string)}} request
 * @param {function({status:boolean, message:string, request:?})} startCb
 * @param {function(?)} progressCb
 * @param {function({status:boolean,message:string})} completeCb
 */

aurora.Upload = function(request, startCb, progressCb, completeCb) {
    var formData = new FormData();
    for (var index in request.data) {
        formData.append(index, request.data[index]);
    }
    var dataType = (request.dataType == undefined ? 'json' : request.dataType);

    var ajax = jQuery.ajax({
        url: request.url,
        data: formData,
        dataType: dataType,
        cache: false,
        contentType: false,
        processData: false,
        type: 'POST',
        success: function(returnData) {
            console.log('success!');
            ajax = null;
            console.log(returnData);
            completeCb({status: true, message: returnData});//.replace("<!-- EOF ->", "")
        },
        error: function(error) {
            ajax = null;
            console.log('error!');
            console.log(error);
            completeCb({status: false, message: error});
        },
        beforeSend: function(jqXHR, settings) {
            startCb({status: true, message: 'starting', request: request});
        },
        xhr: function() {  // custom xhr
            var myXhr = $.ajaxSettings.xhr();
            if (myXhr.upload) { // check if upload property exists
                // note this currently doesn't work on edge due to a bug
                // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/12224510/
                var progresFunc = function(prog) {
                    progressCb(prog);
                };
                myXhr.upload.addEventListener('progress', progresFunc, false);
            }
            return myXhr;
        }
    });
    this.ajax_ = ajax;
};
/**
 * @param {?} val
 */
aurora.Upload.prototype.abort = function(val) {
    if (this.ajax_) {
        this.ajax_.abort(val);
    }
};

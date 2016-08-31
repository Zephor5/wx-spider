const fs = require("fs");
const xpath = require('xpath');
const dom = require('xmldom').DOMParser;
const path = require('path');
const log4js = require('log4js');

var cacheLogger = log4js.getLogger('Cache');

var BlogCache = function(cache_path) {
    this._cache_path = cache_path ? cache_path : './';
    this._cache_file = path.join(this._cache_path, 'cache.data');
    this._cache = {};
    if (fs.existsSync(this._cache_file)) {
        var data = fs.readFileSync(this._cache_file).toString();
        this._cache = JSON.parse(data ? data : '{}');
    }
    else {
        cacheLogger.info('no previous blogs');
    }
}
BlogCache.prototype.limits = 100;

BlogCache.prototype.cleanup = function() {
    try {
        fs.writeFileSync(this._cache_file, JSON.stringify(this._cache));
    } catch (e) {
        cacheLogger.error('write cache file fail: %s', e.message);
    }
}

BlogCache.prototype.addBlog = function(publicID, blog) {
    if (!(publicID in this._cache))
        this._cache[publicID] = {
            "list": [],
            "upTime": Date.now()
        };
    var len = this._cache[publicID]['list'].unshift(blog);
    this._cache[publicID]['upTime'] = Date.now();
    if (len > this.limits)
        this._cache[publicID]['list'].pop();
}
BlogCache.prototype.parseBlogContent = function(publicID, Content) {
    var doc = new dom().parseFromString(
            Content.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')),
        _added = false;
    var items = xpath.select("//category/item", doc);
    if (items.length) {
        _added = true;
    }
    for (var i = 0; i < items.length; i++) {
        var blog = {
            "title": xpath.select("title/text()", items[i]).toString().slice(9, -3),
            "url": xpath.select("url/text()", items[i]).toString().slice(9, -3)
        }
        this.addBlog(publicID, blog);
    }
    return _added;

}
BlogCache.prototype.getBlogList = function(publicID) {
    if (!(publicID in this._cache))
        return {
            'list': [],
            'upTime': 0
        };
    this._cache[publicID]['upTime'] = Date.now();
    return this._cache[publicID];
}
BlogCache.prototype.getBlogLists = function() {
    return this._cache;
}

module.exports = BlogCache;

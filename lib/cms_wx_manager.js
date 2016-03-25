const http=require('http');
const url=require('url');
const querystring = require("querystring");
const WxClient = require('./wx_client_cms.js');

var BlogCache = function() {
  this._cache={};
}
BlogCache.prototype.limits=100;
BlogCache.prototype.addBlog = function(publicID, blog) {
  if(!(publicID in this._cache))
    this._cache[publicID] = [];
  var len = this._cache[publicID].unshift(blog);
  if(len>this.limits)
    this._cache[publicID].pop();
}
BlogCache.prototype.getBlogList = function(publicID) {
  if(!(publicID in this._cache))
    return [];
  return this._cache[publicID];
}
BlogCache.prototype.getBlogLists = function() {
  return this._cache;
}
var server=new http.Server();
var blogcache = new BlogCache();
var wxClient = new WxClient(blogcache);

server.on('request', (function(req, res){
  req_url = url.parse(req.url);
  if (req_url.pathname.indexOf('/v1/wxspider/blogs')!=-1) {
    var publicID_r = req_url.pathname.match(/\/v1\/wxspider\/blogs\/(.+)/);
    if(!publicID_r) {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.write(JSON.stringify(blogcache.getBlogLists()));
      res.end();
    }
    else {
      var publicID = publicID_r[1];
      publicID = querystring.unescape(publicID);
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.write(JSON.stringify(blogcache.getBlogList(publicID)));
      res.end();
    }
  }
  else
  {
    res.statusCode=404;
    res.statusMessage='Not found';
    console.log('404');
    res.end();
  }
}).bind(this));

server.listen(8086, callback=function(){
  console.log('Server starting...');
  wxClient.run();
});

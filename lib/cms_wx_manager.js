const http=require('http');
const url=require('url');
const querystring = require("querystring");
const fs = require("fs");
const args = require("minimist")(process.argv.slice(2))
const xpath=require('xpath');
const dom=require('xmldom').DOMParser;
const path = require('path');
const WxClient = require('./wx_client_cms.js');

var BlogCache = function(cache_path) {
  this._cache_path = cache_path?cache_path:'./';
  this._cache_file = path.join(this._cache_path, 'cache.data');
  this._cache={};
  try{
    fs.accessSync(this._cache_file, fs.R_OK | fs.W_OK);
    var data = fs.readFileSync(this._cache_file);
    this._cache = JSON.parse(data);
  }
  catch(e){
    console.log('no previous blogs');
  }
}
BlogCache.prototype.limits=100;
BlogCache.prototype.addBlog = function(publicID, blog) {
  if(!(publicID in this._cache))
    this._cache[publicID] = {"list":[], "upTime": Date.now()};
  var len = this._cache[publicID]['list'].unshift(blog);
  this._cache[publicID]['upTime'] = Date.now();
  if(len>this.limits)
    this._cache[publicID]['list'].pop();
  fs.writeFile(this._cache_file, JSON.stringify(this._cache), function(err){
    if(err){
      console.log(err);
      console.warn('write cache file fail');
    }
  });
}
BlogCache.prototype.parseBlogContent = function(publicID, Content) {
  var doc = new dom().parseFromString(
    Content.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
  var items = xpath.select("//category/item", doc);
  for(var i=0; i<items.length; i++) {
    var blog = {
      "title": xpath.select("title/text()", items[i]).toString().slice(9, -3),
      "url": xpath.select("url/text()", items[i]).toString().slice(9, -3)
    }
    this.addBlog(publicID, blog);
  }

}
BlogCache.prototype.getBlogList = function(publicID) {
  if(!(publicID in this._cache))
    return {'list': [], 'upTime': 0};
  this._cache[publicID]['upTime'] = Date.now();
  return this._cache[publicID];
}
BlogCache.prototype.getBlogLists = function() {
  return this._cache;
}
var server=new http.Server();
var blogcache = new BlogCache(args.staticPath);
var wxClient = new WxClient(args.staticPath,
                            args.clientName,
                            blogcache);

var client_check = function() {
  if(!wxClient.status()) {
    console.log('重新登录中。。。');
    wxClient.stop();
    wxClient.run();
  }
}

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
  else if(req_url.pathname.indexOf('/v1/wxspider/qrcode')!=-1) {
    fs.exists(wxClient.qrcode_file, function(exists){
      if(!exists) {
        res.writeHead(404);
        res.write("could not find %s", wxClient.qrcode_file);
        res.end();
      }
      else {
        fs.readFile(wxClient.qrcode_file, "binary", function(err, file){
          if(err) {
            res.writeHead(500);
            res.end(err);
          }
          else {
            res.write(file, "binary");
            res.end();
          }
        });
      }
    });
  }
  else
  {
    res.statusCode=404;
    res.statusMessage='Not found';
    console.log('404');
    res.end();
  }
}).bind(this));

server.listen(args.port, callback=function(){
  console.log('Server starting...');
  wxClient.run();
  setInterval(client_check, 30000);
});

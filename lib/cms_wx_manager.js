const http=require('http');
const url=require('url');
const querystring = require("querystring");
const fs = require("fs");
const args = require("minimist")(process.argv.slice(2))
const WxClient = require('./wx_client_cms.js');
const BlogCache = require('./blog_cache.js');

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

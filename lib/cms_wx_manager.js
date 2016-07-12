const http = require('http');
const url = require('url');
const querystring = require("querystring");
const fs = require("fs");
const args = require("minimist")(process.argv.slice(2));
const path = require('path');
const util = require('util');
const log4js = require('log4js');
const WxClient = require('./wx_client_cms.js');
const BlogCache = require('./blog_cache.js');

log4js.configure({
    appenders: [{
        type: 'console',
        layout: {
            type: "basic"
        }
    }],
    replaceConsole: true
});


var serverLogger = log4js.getLogger('Server');

var _proxies = [
    "172.16.11.43",
    "172.16.11.44",
    "172.16.11.45",
    "172.16.11.46",
    "172.16.193.21",
    "172.16.193.22",
    "172.16.193.43",
    "172.16.174.224",
    "172.16.38.58",
    "172.16.38.59",
    "172.16.38.60",
    "172.16.38.62"
];

function _get_proxy() {
    if (_proxies.length) {
        return util.format("http://%s:3128", _proxies.shift());
    } else {
        return false;
    }
}

var server = new http.Server();
var blogcache = new BlogCache(args.staticPath);
var wxClient = new WxClient(args.staticPath,
    args.clientName,
    blogcache);
var globalNames = {};
var extraClients = [];

var clients_data_path = args.staticPath ? args.staticPath : './';
clients_data_path = path.join(clients_data_path, 'clients.data');


function init_clients() {
    try {
        fs.accessSync(clients_data_path, fs.R_OK | fs.W_OK);
        var _d = fs.readFileSync(clients_data_path).toString();
        globalNames = JSON.parse(_d ? _d : '[]');
        for (var name in globalNames) {
            if (name === wxClient.clientName) continue;
            // 这两行是过渡代码
            var proxy;
            if (globalNames[name] === true) {
                proxy = _get_proxy();
                globalNames[name] = proxy;
            } else {
                proxy = globalNames[name];
                for (var i = 0; i < _proxies.length; i++) {
                    if (proxy.indexOf(_proxies[i]) !== -1) {
                        _proxies.splice(i, 1);
                        break;
                    }
                }
            }
            extraClients.push(new WxClient(wxClient.data_path, name, blogcache, proxy));
        }
    } catch (e) {
        serverLogger.error(e.message);
        serverLogger.info('no extra clients');
    }
    globalNames[wxClient.clientName] = true;
    up_clients_data(); // 过渡代码
}

function up_clients_data() {
    fs.writeFile(clients_data_path, JSON.stringify(globalNames), function(err) {
        if (err) {
            serverLogger.error('write clients file fail');
        }
    });
}

function client_check() {
    if (!wxClient.is_running()) {
        console.warn('%s:重新启动中。。。', wxClient.clientName);
        wxClient.clean_r();
        wxClient.run();
    }
    for (var i = 0; i < extraClients.length; i++) {
        if (!extraClients[i].is_running()) {
            console.warn('%s:重新启动中。。。', extraClients[i].clientName);
            extraClients[i].clean_r();
            extraClients[i].run();
        }
    }
}

init_clients();

server.on('request', (function(req, res) {
    req_url = url.parse(req.url);
    if (req_url.pathname.indexOf('/v1/wxspider/blogs') != -1) {
        var publicID_r = req_url.pathname.match(/\/v1\/wxspider\/blogs\/(.+)/);
        if (!publicID_r) {
            res.writeHead(200, {
                'Content-Type': 'text/plain'
            });
            res.write(JSON.stringify(blogcache.getBlogLists()));
            res.end();
        } else {
            var publicID = publicID_r[1];
            publicID = querystring.unescape(publicID);
            res.writeHead(200, {
                'Content-Type': 'text/plain'
            });
            res.write(JSON.stringify(blogcache.getBlogList(publicID)));
            res.end();
        }
    } else if (req_url.pathname.indexOf('/v1/wxspider/qrcode') != -1) {
        var c = wxClient,
            clientName = req_url.pathname.match(/\/v1\/wxspider\/qrcode\/(.+)/);
        clientName = clientName ? clientName[1] : false;
        if (clientName === wxClient.clientName) {
            c = wxClient;
        } else {
            for (var i = 0; i < extraClients.length; i++) {
                if (extraClients[i].clientName === clientName) {
                    c = extraClients[i];
                }
            }
        }
        if (!c.is_online()) {
            fs.exists(c.qrcode_file, function(exists) {
                if (!exists) {
                    res.writeHead(404);
                    res.write("could not find %s", c.qrcode_file);
                    res.end();
                } else {
                    fs.readFile(c.qrcode_file, "binary", function(err, file) {
                        if (err) {
                            res.writeHead(500);
                            res.end(err);
                        } else {
                            res.write(file, "binary");
                            res.end();
                        }
                    });
                }
            });
        } else {
            res.writeHead(200, {
                'Content-Type': 'text/plain'
            });
            res.write(JSON.stringify({
                status: false,
                msg: '已经登录'
            }));
            res.end();
        }
    } else if (req_url.pathname.indexOf('/v1/wxspider/manage') != -1) {
        var action = req_url.query.match(/\baction=([^&]+)/);
        action = action ? action[1] : false;
        var clientName = req_url.query.match(/\bclientName=([^&]+)/);
        clientName = clientName ? clientName[1] : false;

        var result = {
            status: false,
            msg: ''
        };

        switch (action) {
            case 'add':
                if (clientName && !globalNames[clientName]) {
                    var proxy = _get_proxy();
                    if (proxy === false) {
                        result['msg'] = '无可用代理';
                        break;
                    }
                    var c = new WxClient(wxClient.data_path, clientName, blogcache, proxy);
                    extraClients.push(c);
                    globalNames[clientName] = proxy;
                    up_clients_data();
                    c.run();
                    result['status'] = true;
                    result['msg'] = '添加成功，请<a href="/v1/wxspider/qrcode">点击</a>扫描二维码登录';
                }
                break;
            case 'del':
                if (clientName && globalNames[clientName] && clientName !== wxClient.clientName) {
                    delete globalNames[clientName];
                    for (var i = 0; i < extraClients.length; i++) {
                        if (extraClients[i].clientName === clientName) {
                            serverLogger.log(util.format('移除客户端：%s...', clientName));
                            extraClients[i].stop();
                            extraClients.splice(i, 1);
                            break;
                        }
                    }
                    up_clients_data();
                    result['status'] = true;
                    result['msg'] = '删除成功';
                }
                break;
            case 'reset':
                if (clientName && globalNames[clientName]) {
                    if (clientName === wxClient.clientName) {
                        wxClient.reset();
                    } else {
                        for (var i = 0; i < extraClients.length; i++) {
                            if (extraClients[i].clientName === clientName) {
                                extraClients[i].reset();
                            }
                        }
                    }
                    result['status'] = true;
                } else {
                    result['msg'] = '客户端名称有误';
                }
                break;
            case 'list':
                result['status'] = true;
                result['msg'] = {};
                result['msg'][wxClient.clientName] = wxClient.readable_status();
                for (var i = 0; i < extraClients.length; i++) {
                    result['msg'][extraClients[i].clientName] = extraClients[i].readable_status();
                }
            default:
        }
        res.writeHead(200, {
            'Content-Type': 'text/plain'
        })
        res.write(JSON.stringify(result));
        res.end();
    } else {
        res.statusCode = 404;
        res.statusMessage = 'Not found';
        serverLogger.warn(req.url + ' 404');
        res.end();
    }
}).bind(this));
server.listen(args.port, args.host, callback = function() {
    serverLogger.info('Server starting...');
    wxClient.run();
    for (var i = 0; i < extraClients.length; i++) {
        extraClients[i].run();
    };
    setInterval(client_check, 35000);
});


process.stdin.resume(); //so the program will not close instantly

function exitHandler(options, err) {
    if (options.cleanup) {
        blogcache.cleanup();
        wxClient.cleanup();
        for (var i = 0; i < extraClients.length; i++) {
            extraClients[i].cleanup();
        }
    }
    if (err) serverLogger.error(err.stack);
    if (options.exit) process.exit();
}

//do something when app is closing
process.on('exit', exitHandler.bind(null, {
    cleanup: true
}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {
    exit: true
}));

//catches stop event
process.on('SIGTERM', exitHandler.bind(null, {
    exit: true
}));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {
    exit: true
}));
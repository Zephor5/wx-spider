const https = require('https');
const request = require('request');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const xpath = require('xpath');
const dom = require('xmldom').DOMParser;
const log4js = require('log4js');

const STATUS_ONLINE = 2;
const STATUS_LOGGING = 1;
const STATUS_OFFLINE = 0;

var clientLogger = log4js.getLogger('Client');

var WxClient = function(qrcode_path, clientName, blogList) {
    this.domain = 'wx.qq.com';
    this.qrcode_path = qrcode_path ? qrcode_path : './';
    this.deviceid = 'e' + parseInt(Math.random() * 1000000000000000);
    this.clientName = clientName ? clientName : this.deviceid;
    this.qrcode_file = path.join(this.qrcode_path, this.clientName + '.png');
    this.online = STATUS_OFFLINE;
    this.uuid;
    this.sid;
    this.uin;
    this.skey;
    this.pass_ticket;
    this.syncKey_dic;
    this.syncKey_str;
    this.myUserName;
    this.cookies = [];
    this.members = {};
    this.groups = {};
    this.blogList = blogList;
    this.dn = +new Date;
};

WxClient.prototype.run = function() {
    this._wx_login()
}

WxClient.prototype.stop = function() {
    this.online = STATUS_OFFLINE;
}

WxClient.prototype._notice_log = function(msg) {
    console.log(msg);
}

WxClient.prototype._wx_login = function() {
    var url = 'https://wx.qq.com/';
    var headers = {
        'Cookie': this.cookies
    };
    request.get({
        url: url,
        headers: headers
    }, (function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var r_list = body.match(/window\.MMCgi\s*=\s*{\s*isLogin\s*:\s*(!!"1")\s*}/);
            this.dn = +new Date;
            if (r_list && r_list[1] == '!!"1"') {
                this.online = STATUS_ONLINE;
                this._wx_sync_check();
                return;
            }
            this._login_get_uuid();
        }
    }).bind(this));
}

WxClient.prototype.status = function() {
    if (!this.online) {
        this._notice_log('客户端已下线');
        return 0;
    }
    return 1;
}

WxClient.prototype._login_get_uuid = function() {
    this.online = STATUS_LOGGING;
    var url = 'https://login.weixin.qq.com/jslogin?appid=wx782c26e4c19acffb&redirect_uri=' + encodeURIComponent("https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxnewloginpage") + "&fun=new&lang=zh_CN&_=" + this.dn++;
    request(url, (function(error, response, body) {
        if (error || response.statusCode != 200) {
            clientLogger.error('获取uuid失败，正在重试...');
            this._wx_login();
            return;
        }
        r_list = body.match(/window\.QRLogin\.code = (\d+); window\.QRLogin\.uuid = "([^"]+)"/);
        if (!r_list) {
            this._wx_get_uuid();
            return;
        }
        this.uuid = r_list[2];
        this._login_get_qrcode();
        this._login_check(1);
    }).bind(this));
}

WxClient.prototype._login_get_qrcode = function() {
    var url = 'https://login.weixin.qq.com/qrcode/' + this.uuid;
    request(url).pipe(fs.createWriteStream(this.qrcode_file));
}

WxClient.prototype._login_check = function(tip) {
    tip = tip || 0;
    var login_check_dict = {
        loginicon: true,
        uuid: this.uuid,
        tip: tip,
        '_': this.dn++,
        r: ~new Date
    }
    var login_check_query = querystring.stringify(login_check_dict);
    var url = 'https://login.weixin.qq.com/cgi-bin/mmwebwx-bin/login?' + querystring.unescape(login_check_query);
    request(url, (function(error, response, body) {
        if (error || response.statusCode != 200) {
            clientLogger.error('login error');
            this._login_get_uuid();
            return;
        }
        var r_list = body.match(/window\.(.+?)=(.+?);/g);
        var r_code = r_list[0].match(/window\.(.+?)=(.+?);/);
        var code = +r_code[2];
        switch (code) {
            case 200:
                this._notice_log("200 正在登录中...");
                var r_direct = r_list[1].match(/window\.redirect_uri="([^"]+)"/);
                var direct = r_direct[1] + '&fun=new&version=v2';
                request(direct, (function(error, response, body) {
                    var doc = new dom().parseFromString(body);
                    this.sid = xpath.select("//wxsid/text()", doc).toString();
                    this.uin = xpath.select("//wxuin/text()", doc).toString();
                    this.skey = xpath.select("//skey/text()", doc).toString();
                    this.pass_ticket = xpath.select("//pass_ticket/text()", doc).toString();
                    for (var i = 0, len = response.headers['set-cookie'].length; i < len; i++) {
                        var r = response.headers['set-cookie'][i].match(/(.+?)=(.+?);/g);
                        this.cookies += r[0];
                    }
                    this._wx_init();
                }).bind(this));
                break;

            case 201:
                this._notice_log("已扫码，请点击登录");
                this._login_check();
                break;
            case 408:
                this._notice_log("等待手机扫描二维码...");
                this._login_check();
                break;
            case 400:
            case 500:
            case 0:
                this._notice_log("等待超时，重新获取二维码...");
                this.run();
        }
    }).bind(this));
}

WxClient.prototype._wx_init = function() {
    var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxinit?r=' + (~new Date) + '&pass_ticket=' + this.pass_ticket + '&lang=zh_CN';
    var data = {
        "BaseRequest": {
            "Uin": parseInt(this.uin),
            "Sid": this.sid,
            "Skey": this.skey,
            "DeviceID": this.deviceid
        }
    };
    var headers = {
        'Cookie': this.cookies
    };
    request.post({
        url: url,
        headers: headers,
        body: JSON.stringify(data)
    }, (function(error, response, body) {
        var init_dict = JSON.parse(body);
        this.syncKey = init_dict['SyncKey'];
        this._wx_form_syncStr();
        this._parse_contact(init_dict['ContactList'], init_dict['Count']);
        this.myUserName = init_dict['User']['UserName']
        this._notice_log("初始化成功，开始监听消息");
        this.online = STATUS_ONLINE;
        this._wx_status_notify();
        this._wx_get_contact();
        this._wx_sync_check();
    }).bind(this));
}

WxClient.prototype._wx_status_notify = function() {
    var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxstatusnotify?pass_ticket=' + this.pass_ticket;
    var data = {
        "BaseRequest": {
            "Uin": parseInt(this.uin),
            "Sid": this.sid,
            "Skey": this.skey,
            "DeviceID": this.deviceid
        },
        "Code": 3,
        "FromUserName": this.myUserName,
        "ToUserName": this.myUserName,
        "ClientMsgId": Date.now()
    }
    request.post({
        url: url,
        body: JSON.stringify(data)
    }, (function(error, response, body) {
        if (error) {
            clientLogger.error('status notify error');
            return;
        } else {
            if (response.statusCode != 200)
                return clientLogger.error('Invaild Status code:', response.statusCode);
            var body_dic = JSON.parse(body);
            if (body_dic['BaseResponse']['Ret'] == 0)
                this._notice_log('状态同步成功');
            else {
                this._notice_log('状态同步失败 ' + body_dic['BaseResponse']['ErrMsg']);
            }
        }
    }).bind(this));
}

WxClient.prototype._parse_contact = function(contactList, count) {
    var groupList = [];
    for (var i = 0; i < count; i++) {
        var userName = contactList[i]['UserName'];
        if (userName.indexOf('@@') != -1) {
            if (!(userName in this.groups)) {
                this.groups[userName] = contactList[i];
                groupList.push(userName);
            }
        } else {
            if (!(userName in this.members)) {
                this.members[userName] = contactList[i];
            }
        }
    }
    this._wx_bath_get_contact(groupList);
};

WxClient.prototype._update_contact = function(userName) {
    if (userName.indexOf('@@') != -1 && !(userName in this.groups))
        this._wx_bath_get_contact([userName]);
};

WxClient.prototype._wx_get_contact = function() {
    var query_dic = {
        'pass_ticket': this.pass_ticket,
        'skey': this.skey,
        'r': Date.now()
    };
    var headers = {
        'Cookie': this.cookies,
        'ContentType': 'application/json; charset=UTF-8'
    };
    var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxgetcontact?' + querystring.unescape(querystring.stringify(query_dic));
    request.get({
        url: url,
        headers: headers
    }, (function(error, response, body) {
        if (error || response.statusCode != 200) {
            clientLogger.error('get contact error');
            return;
        }
        body_dic = JSON.parse(body);
        this._parse_contact(body_dic['MemberList'], body_dic['MemberCount']);
    }).bind(this));
}

WxClient.prototype._wx_bath_get_contact = function(group_list) {
    var query_dic = {
        "type": "ex",
        "pass_ticket": this.pass_ticket,
        "r": Date.now()
    };
    var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxbatchgetcontact?' + querystring.unescape(querystring.stringify(query_dic));
    var groupList = [];
    for (var i = 0; i < group_list.length; i++) {
        groupList.push({
            'UserName': group_list[i],
            'ChatRoomId': ''
        });
    }
    var post_dic = {
        'BaseRequest': {
            "DeviceID": this.deviceid,
            "Sid": this.sid,
            "Skey": this.skey,
            "Uin": this.uin,
        },
        'Count': groupList.length,
        'List': groupList,
    };
    var headers = {
        'Cookie': this.cookies,
        'ContentType': 'application/json; charset=UTF-8'
    };
    request.post({
        url: url,
        headers: headers,
        body: JSON.stringify(post_dic)
    }, (function(error, response, body) {
        if (error || response.statusCode != 200)
            return
        body_dic = JSON.parse(body);
        if (body_dic['BaseResponse']['Ret'] == 0) {
            for (var i = 0, len = body_dic['Count']; i < len; i++) {
                var userName = body_dic['ContactList'][i]['UserName'];
                for (var j = 0, len_j = body_dic['ContactList'][i]['MemberCount']; j < len_j; j++) {
                    var userNameInGroup = body_dic['ContactList'][i]['MemberList'][j]['UserName'];
                    this.members[userNameInGroup] = body_dic['ContactList'][i]['MemberList'][j];
                }
            }
        }
    }).bind(this));
}

WxClient.prototype._wx_form_syncStr = function() {
    var syncStr = '';
    for (var i = 0; i < parseInt(this.syncKey['Count']); i++) {
        syncStr += this.syncKey['List'][i]['Key'] + '_' + this.syncKey['List'][i]['Val'];
        if (i != parseInt(this.syncKey['Count']) - 1)
            syncStr += '|';
    }
    this.syncStr = syncStr;
}

WxClient.prototype._wx_sync_check = function() {
    var query_dic = {
        'r': Date.now(),
        'skey': this.skey,
        'sid': this.sid,
        'uin': this.uin,
        'deviceid': this.deviceid,
        'synckey': this.syncStr,
        '_': this.dn++
    }
    var url = 'https://webpush.weixin.qq.com/cgi-bin/mmwebwx-bin/synccheck?' + querystring.stringify(query_dic);
    var headers = {
        'Referer': 'https://wx.qq.com/',
        'Cookie': this.cookies
    };
    request.get({
        url: url,
        headers: headers
    }, (function(error, response, body) {
        if (error) {
            clientLogger.error('sync check error');
            this._wx_sync_check();
            return;
        } else {
            if (response.statusCode != 200) {
                clientLogger.error('Invaild Status code:', response.statusCode);
                this._wx_sync_check();
                return;
            }
            var r = body.match(/window\.synccheck={retcode:"(\d+)",selector:"(\d+)"}/);
            retcode = r[1];
            selector = +r[2];
            if (retcode == '1100') {
                this._notice_log("你在手机上登出了微信，再见！");
                this.stop();
            } else if (retcode == '1101') {
                this._notice_log("你在其他地方登录了web微信，再见！");
                this.stop();
            } else if (retcode == '1102') {
                this._notice_log("未知登出，再见！");
                this.stop();
            } else if (retcode == '0') {
                switch (selector) {
                    case 0:
                        this._notice_log("同步检查");
                        this._wx_sync_check();
                        break;
                    case 2:
                        this._notice_log("收到了新消息");
                        break;
                    case 4:
                        this._notice_log('朋友圈有新动态');
                        break;
                    case 7:
                        this._notice_log("进入或离开聊天界面");
                        break;
                    default:
                        this._notice_log("未知的selector " + selector);
                }
                if (selector !== 0) {
                    this._wx_sync();
                }
            } else {
                this._notice_log("出现了严重错误");
                this.stop();
            }
        }
    }).bind(this));
}

WxClient.prototype._wx_sync = function() {
    var query_dic = {
        'sid': this.sid,
        'skey': this.skey,
        'pass_ticket': this.pass_ticket,
        'lang': 'zh_CN'
    }
    var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxsync?' + querystring.stringify(query_dic);

    var data = {
        "BaseRequest": {
            "Uin": this.uin,
            "Sid": this.sid
        },
        "SyncKey": this.syncKey,
        "rr": ~new Date
    };
    request.post({
        url: url,
        body: JSON.stringify(data)
    }, (function(error, response, body) {
        if (error || response.statusCode != 200) {
            clientLogger.warn('sync error');
            this._wx_sync_check();
            return;
        }
        msgBody = JSON.parse(body);
        if (msgBody['BaseResponse']['Ret'] != 0) {
            this._wx_sync_check();
            return;
        }
        this._wx_sync_check();
        this.syncKey = msgBody['SyncKey'];
        this._wx_form_syncStr();
        this._handle_msg(msgBody['AddMsgList']);
    }).bind(this));
}

WxClient.prototype._handle_msg = function(msgs) {
    for (var i = 0, len = msgs.length; i < len; i++) {
        var msgType = msgs[i]['MsgType'];
        var userName = msgs[i]['FromUserName'];
        var name = this._get_user_remark_name(msgs[i]['FromUserName']);
        var msgId = msgs[i]['MsgId'];
        var content = querystring.unescape(msgs[i]['Content']);

        switch (msgType) {
            case 1:
                this._show_msg(msgs[i]);
                break;
            case 3:
                this._notice_log(name + ': 发送了一张图片，暂不支持，请前往手机查看');
                break;
            case 34:
                this._notice_log(name + ': 发送了一段语音，暂不支持，请前往手机查看');
                break;
            case 42:
                this._notice_log(name + ': 发送了一张名片，暂不支持，请前往手机查看');
                break;
            case 47:
                this._notice_log(name + ': 发送了一个表情，暂不支持，请前往手机查看');
                break;
            case 49:
                var url = msgs[i]['Url'].replace(/&amp;/g, '&');
                this._notice_log('标题: ' + msgs[i]['FileName']);
                this._notice_log('链接: ' + url);
                this._notice_log(name + '，分享了一个链接，请粘贴url到浏览器查看');
                var blog = {
                    'title': msgs[i]['FileName'],
                    'url': url
                };
                if (!this.blogList.parseBlogContent(
                        this._get_public_alias(userName), msgs[i]['Content'])) {
                    this.blogList.addBlog(
                        this._get_public_alias(userName), blog);
                }
                break;
            case 51:
                this._notice_log('获取了联系人信息');
                this._update_contact(msgs[i]['ToUserName']);
                break;
            case 62:
                this._notice_log(name + ': 发送了一段视频，暂不支持，请前往手机查看');
                break;
            case 10002:
                this._notice_log(name + ': 撤回了一条消息');
                break;
            default:
                this._notice_log('发现未定义的msgType ' + msgType);
                this._notice_log(msgs[i]);

        }
    }
}

WxClient.prototype._show_msg = function(msg) {
    if (msg) {
        var srcName = this._get_user_remark_name(msg['FromUserName']);
        var dstName = this._get_user_remark_name(msg['ToUserName']);
        var content = msg['Content'];
        var msg_id = msg['MsgId'];

        this._notice_log(srcName + ' -> ' + dstName + ': ' + content);
    }
}

WxClient.prototype._get_user_remark_name = function(userName) {
    var remarkName;
    if (userName.indexOf('@@') == 0 && userName in this.groups) {
        remarkName = this.groups[userName]['RemarkName'];
        remarkName = remarkName ? remarkName : this.groups[userName]['NickName'];
    } else if (userName.indexOf('@@') == 0 && !(userName in this.groups)) {
        this._wx_bath_get_contact([userName]);
    } else if (userName in this.members) {
        remarkName = this.members[userName]['RemarkName'];
        remarkName = remarkName ? remarkName : this.members[userName]['NickName']
    }
    return remarkName ? remarkName : '未知';
}

WxClient.prototype._get_public_alias = function(userName) {
    if (!(userName in this.members)) {
        this._wx_bath_get_contact([userName]);
        return '未知';
    }
    var alias = '';
    if ('Alias' in this.members[userName]) {
        alias = this.members[userName]['Alias'];
    }
    alias = alias ? alias : this._get_user_remark_name(userName);
    return alias ? alias : '未知';
}
module.exports = WxClient;
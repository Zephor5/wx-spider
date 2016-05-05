const https = require('https');
const FileCookieStore = require('tough-cookie-filestore');
const request = require('request');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const xpath = require('xpath');
const dom = require('xmldom').DOMParser;
const log4js = require('log4js');
const util = require('util');

const STATUS_ONLINE = 2;
const STATUS_WAITING = 1;
const STATUS_STOPPED = 0;

var clientLogger = log4js.getLogger('Client');

var WxClient = function(data_path, clientName, blogList) {
    this.domain = 'wx.qq.com';
    this.data_path = data_path ? data_path : './';
    this.deviceid = 'e' + parseInt(Math.random() * 1000000000000000);
    this.clientName = clientName ? clientName : this.deviceid;
    this.qrcode_file = path.join(this.data_path, this.clientName + '.png');
    this.runtime_data_file = path.join(this.data_path, this.clientName + '.dat');
    var cookie_file = path.join(this.data_path, this.clientName + '.cookies');
    try {
        fs.accessSync(cookie_file, fs.R_OK | fs.W_OK);
    } catch (e) {
        fs.writeFileSync(cookie_file, '');
    }
    this.cookie_stor = new FileCookieStore(cookie_file);
    this.cr = request.defaults({
        jar: request.jar(this.cookie_stor)
    });
    this.online = STATUS_STOPPED;
    this.dn = +new Date;
    this.uuid = null;
    this.sid = null;
    this.uin = null;
    this.skey = null;
    this.pass_ticket = null;
    this.syncKey = null;
    this.syncStr = null;
    this.myUserName = null;
    this.members = {};
    this.groups = {};
    this.blogList = blogList;
    this.login_check_r = null;
    this.sync_check_r = null;
    this.uptime = +new Date;

    var runtime_keys = ":deviceid:uuid:sid:uin:skey:pass_ticket:syncKey:syncStr:myUserName:members:groups:dn:";
    try {
        fs.accessSync(this.runtime_data_file, fs.R_OK | fs.W_OK);
        var data = fs.readFileSync(this.runtime_data_file).toString();
        data = JSON.parse(data ? data : '{}');
        for (var k in data) {
            if (runtime_keys.indexOf(":" + k + ":") !== -1) {
                this[k] = data[k];
            }
        }
    } catch (e) {
        this._error_log(e.message);
        this._notice_log('no previous data');
    }
};

WxClient.prototype.cleanup = function() {
    var dat = {
        'deviceid': this.deviceid,
        'uuid': this.uuid,
        'sid': this.sid,
        'uin': this.uin,
        'skey': this.skey,
        'pass_ticket': this.pass_ticket,
        'syncKey': this.syncKey,
        'syncStr': this.syncStr,
        'myUserName': this.myUserName,
        'members': this.members,
        'groups': this.groups,
        'dn': this.dn
    };
    try {
        fs.writeFileSync(this.runtime_data_file, JSON.stringify(dat));
    } catch (e) {
        this._notice_log(util.format('write data file fail: %s', e.message));
    }
}

WxClient.prototype.reset = function() {
    this.deviceid = 'e' + parseInt(Math.random() * 1000000000000000);
    this.dn = +new Date;
    this.uuid = null;
    this.sid = null;
    this.uin = null;
    this.skey = null;
    this.pass_ticket = null;
    this.syncKey = null;
    this.syncStr = null;
    this.myUserName = null;
    this.members = {};
    this.groups = {};
    this.cookie_stor.removeCookies(this.domain, null, function() {});
}

WxClient.prototype.run = function() {
    this._wx_login();
}

WxClient.prototype.stop = function() {
    if (this.login_check_r)
        this.login_check_r.abort();
    if (this.sync_check_r)
        this.sync_check_r.abort();
    this.online = STATUS_STOPPED;
}

WxClient.prototype.is_running = function() {
    return +new Date - this.uptime < 35000;
}

WxClient.prototype.is_online = function() {
    return this.is_running() && this.online === STATUS_ONLINE;
}

WxClient.prototype.readable_status = function() {
    return ['STOPPED', 'WAITING', 'ONLINE'][this.online];
}

WxClient.prototype._notice_log = function(msg) {
    clientLogger.log('%s：%s', this.clientName, msg);
}

WxClient.prototype._warn_log = function(msg) {
    clientLogger.warn('%s：%s', this.clientName, msg);
}

WxClient.prototype._error_log = function(msg) {
    clientLogger.error('%s：%s', this.clientName, msg);
}

WxClient.prototype._wx_login = function() {
    var url = 'https://wx.qq.com/';
    this.cr.get(url, (function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var r_list = body.match(/window\.MMCgi\s*=\s*{\s*isLogin\s*:\s*(!!"1")\s*}/);
            if (r_list && r_list[1] == '!!"1"') {
                this.online = STATUS_ONLINE;
                this._notice_log("微信已登录");
                this.sync_check_r = this._wx_sync_check();
            } else {
                this._login_get_uuid();
            }
            this.uptime = +new Date;
        }
    }).bind(this));
}

WxClient.prototype._login_get_uuid = function() {
    this.reset();
    this.online = STATUS_WAITING;
    var url = 'https://login.weixin.qq.com/jslogin?appid=wx782c26e4c19acffb&redirect_uri=' + encodeURIComponent("https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxnewloginpage") + "&fun=new&lang=zh_CN&_=" + this.dn++;
    this.cr(url, (function(error, response, body) {
        if (error || response.statusCode != 200) {
            this._error_log(util.format('获取uuid失败，正在重试...%s', error ? error.message : response.statusCode));
            setTimeout(this._wx_login.bind(this), 500);
            return;
        }
        r_list = body.match(/window\.QRLogin\.code = (\d+); window\.QRLogin\.uuid = "([^"]+)"/);
        if (!r_list) {
            this._login_get_uuid();
            return;
        }
        this.uuid = r_list[2];
        this._login_get_qrcode();
        this.login_check_r = this._login_check(1);
    }).bind(this));
}

WxClient.prototype._login_get_qrcode = function() {
    var url = 'https://login.weixin.qq.com/qrcode/' + this.uuid;
    this.cr(url).on('response', (function(response) {
        this._notice_log("二维码就绪...");
    }).bind(this)).on('error', (function(err) {
        this._notice_log("下载二维码失败...重新获取");
        this._login_get_uuid();
        if (this.login_check_r) {
            this.login_check_r.abort();
        }
    }).bind(this)).pipe(fs.createWriteStream(this.qrcode_file));
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
    return this.cr(url, (function(error, response, body) {
        if (error || response.statusCode != 200) {
            this._error_log(util.format('login check error: %s', error ? error.message : response.statusCode));
            this._login_get_uuid();
            return;
        }
        var r_list = body.match(/window\.(.+?)=(.+?);/g);
        var r_code = r_list[0].match(/window\.(.+?)=(.+?);/);
        var code = +r_code[2];
        switch (code) {
            case 200:
                this.login_check_r = null;
                this._notice_log("200 正在登录中...");
                var r_direct = r_list[1].match(/window\.redirect_uri="([^"]+)"/);
                var direct = r_direct[1] + '&fun=new&version=v2';
                this.cr(direct, (function(error, response, body) {
                    var doc = new dom().parseFromString(body);
                    this.sid = xpath.select("//wxsid/text()", doc).toString();
                    this.uin = xpath.select("//wxuin/text()", doc).toString();
                    this.skey = xpath.select("//skey/text()", doc).toString();
                    this.pass_ticket = xpath.select("//pass_ticket/text()", doc).toString();
                    this._wx_init();
                }).bind(this));
                break;

            case 201:
                this.uptime = +new Date;
                this._notice_log("已扫码，请点击登录");
                this.login_check_r = this._login_check();
                break;
            case 408:
                this.uptime = +new Date;
                this._notice_log("等待手机扫描二维码...");
                this.login_check_r = this._login_check();
                break;
            case 400:
            case 500:
            case 0:
                this._notice_log("等待超时，重新获取二维码...");
                this.login_check_r = null;
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
    this.cr.post({
        url: url,
        body: JSON.stringify(data)
    }, (function(error, response, body) {
        var init_dict = JSON.parse(body);
        this.syncKey = init_dict['SyncKey'];
        this._wx_form_syncStr();
        this._parse_contact(init_dict['ContactList'], init_dict['Count']);
        this.myUserName = init_dict['User']['UserName'];
        this._notice_log("初始化成功，开始监听消息");
        this.online = STATUS_ONLINE;
        this._wx_status_notify();
        this._wx_get_contact();
        this.sync_check_r = this._wx_sync_check();
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
    this.cr.post({
        url: url,
        body: JSON.stringify(data)
    }, (function(error, response, body) {
        if (error) {
            this._error_log('status notify error');
            return;
        } else {
            if (response.statusCode != 200) {
                this._error_log(util.format('Invaild Status code: %s', response.statusCode));
                return;
            }
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
            this.groups[userName] = contactList[i];
            groupList.push(userName);
        } else {
            this.members[userName] = contactList[i];
        }
    }
    if (groupList.length) {
        this._wx_bath_get_contact(groupList);
    }
};

WxClient.prototype._wx_get_contact = function() {
    var query_dic = {
        'pass_ticket': this.pass_ticket,
        'skey': this.skey,
        'r': Date.now()
    };
    var headers = {
        'ContentType': 'application/json; charset=UTF-8'
    };
    var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxgetcontact?' + querystring.unescape(querystring.stringify(query_dic));
    this.cr.get({
        url: url,
        headers: headers
    }, (function(error, response, body) {
        if (error || response.statusCode != 200) {
            this._error_log('get contact error');
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
        'ContentType': 'application/json; charset=UTF-8'
    };
    this.cr.post({
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
        'Referer': 'https://wx.qq.com/'
    };
    this.uptime = +new Date;
    return this.cr.get({
        url: url,
        headers: headers
    }, (function(error, response, body) {
        if (error) {
            this._error_log(util.format('sync check error: %s', error.message));
            this.sync_check_r = this._wx_sync_check();
            return;
        } else {
            if (response.statusCode != 200) {
                this._error_log(util.format('Invaild Status code: %s', response.statusCode));
                this.sync_check_r = this._wx_sync_check();
                return;
            }
            var r = body.match(/window\.synccheck={retcode:"(\d+)",selector:"(\d+)"}/);
            if (!r) {
                this._error_log(util.format('Invaild body of synccheck: %s', body));
                this.sync_check_r = this._wx_sync_check();
                return;
            }
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
                        this.sync_check_r = this._wx_sync_check();
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
    this.cr.post({
        url: url,
        body: JSON.stringify(data)
    }, (function(error, response, body) {
        if (error || response.statusCode != 200) {
            this._warn_log('sync error');
            this.sync_check_r = this._wx_sync_check();
            return;
        }
        msgBody = JSON.parse(body);
        if (msgBody['BaseResponse']['Ret'] != 0) {
            this._notice_log("微信登出，再见！");
            this.stop();
            return;
        }
        this.syncKey = msgBody['SyncKey'];
        this._wx_form_syncStr();
        for (var i = 0; i < msgBody['DelContactList'].length; i++) {
            delete this.members[msgBody['DelContactList'][i]['UserName']];
        }
        this._parse_contact(msgBody['ModContactList'], msgBody['ModContactCount']);
        this._handle_msg(msgBody['AddMsgList']);
        this.sync_check_r = this._wx_sync_check();
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
                this._notice_log('状态提示：' + content);
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
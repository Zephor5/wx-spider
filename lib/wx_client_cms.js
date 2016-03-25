var https = require('https');
var request = require('request');
var querystring = require('querystring');
var fs=require('fs');
var xpath=require('xpath');
var dom=require('xmldom').DOMParser;

var QRCODE_PATH = '/Users/Ethan-Zhang/Desktop/xxx.png';

var WxClient = function(blogList){
  this.domain = 'wx.qq.com';
  this.online = 0;
  this._intervalTimer;
  this.deviceid = 'e'+parseInt(Math.random()*1000000000000000);
  this.uuid;
  this.sid;
  this.uin;
  this.skey;
  this.pass_ticket;
  this.syncKey_dic;
  this.syncKey_str;
  this.cookies=[];
  this.members={};
  this.groups={};
  this.blogList=blogList;
};

WxClient.prototype.run = function() {
  this._login_get_uuid();
}

WxClient.prototype._login_get_uuid = function() {
  var url='https://login.weixin.qq.com/jslogin?appid=wx782c26e4c19acffb';
  request(url, (function(error, response, body){
    r_list=body.match(/window\.QRLogin\.code = (\d+); window\.QRLogin\.uuid = "([^"]+)"/);
    this.uuid = r_list[2];
    this._login_get_qrcode();
  }).bind(this));
}

WxClient.prototype._login_get_qrcode = function() {
  var url='https://login.weixin.qq.com/qrcode/'+this.uuid+'?t=webwx';
  request(url).on('response', (function(response) {
    console.log("等待手机扫描二维码...");
    this._wait_to_login();
  }).bind(this))
  .pipe(fs.createWriteStream(QRCODE_PATH));
}

WxClient.prototype._wait_to_login = function() {
  var login_check_dict= {
    loginicon: true,
    uuid: this.uuid,
    tip: 1,
    '_': Date.now(),
  }
  var login_check_query=querystring.stringify(login_check_dict);
  var url='https://login.weixin.qq.com/cgi-bin/mmwebwx-bin/login?'+querystring.unescape(login_check_query);
  request(url, (function(error, response, body) {
    var r_list = body.match(/window\.(.+?)=(.+?);/g);
    var r_code = r_list[0].match(/window\.(.+?)=(.+?);/);
    var code = r_code[2];
    if(code=='200') {
      console.log("[*] 200 正在登录中...");
      var r_direct = r_list[1].match(/window\.redirect_uri="([^"]+)"/);
      var direct = r_direct[1]+'&fun=new';
      request(direct, (function(error, response, body){
        var doc = new dom().parseFromString(body);
        this.sid = xpath.select("//wxsid/text()", doc).toString();
        this.uin = xpath.select("//wxuin/text()", doc).toString();
        this.skey = xpath.select("//skey/text()", doc).toString();
        this.pass_ticket = xpath.select("//pass_ticket/text()", doc).toString();
        for(var i=0, len=response.headers['set-cookie'].length; i<len; i++) {
          var r = response.headers['set-cookie'][i].match(/(.+?)=(.+?);/g);
          this.cookies+=r[0];
        }
        this._wx_init();
      }).bind(this));
    }
    else if(code=='201') {
      console.log("[*] 201 已扫码，请点击登录");
      setTimeout(this._wait_to_login.bind(this), 3000);
    }
    else
      console.log("[*] "+code+" 登录异常");
  }).bind(this));
}

WxClient.prototype._wx_init = function() {
  var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxinit?r='+Date.now()+'&pass_ticket='+this.pass_ticket;
  var data = { "BaseRequest":
                {"Uin": parseInt(this.uin), "Sid": this.sid, "Skey": this.skey, "DeviceID": this.deviceid}
  };
  var headers={'Cookie': this.cookies};
  request.post({url:url, headers: headers, body: JSON.stringify(data)}, (function(error, response, body){
    var init_dict = JSON.parse(body);
    this.syncKey = init_dict['SyncKey'];
    this._wx_form_syncStr();
    this._parse_contact(init_dict['ContactList'], init_dict['Count']);
    console.log("[*] 初始化成功，开始监听消息");
    this.online = 1;
    this._wx_get_contact();
    //this._wx_bath_get_contact();
    this._intervalTimer = setInterval(this._wx_sync_check.bind(this), 6000);
  }).bind(this));
}

WxClient.prototype._parse_contact = function (contactList, count) {
  var groupList = [];
  for(var i=0; i<count; i++) {
    var userName = contactList[i]['UserName'];
    if(userName.indexOf('@@') != -1) {
      if(!(userName in this.groups)) {
        this.groups[userName] = contactList[i];
        groupList.push(userName);
      }
    }
    else {
      if(!(userName in this.members)) {
        this.members[userName] = contactList[i];
      }
    }
  }
  this._wx_bath_get_contact(groupList);
};

WxClient.prototype._update_contact = function (userName) {
  if(userName.indexOf('@@')!=-1 && !(userName in this.groups))
    this._wx_bath_get_contact([userName]);
};

WxClient.prototype._wx_get_contact = function() {
  var query_dic = {'pass_ticket': this.pass_ticket,
                  'skey': this.skey,
                  'r': Date.now()};
  var headers = {'Cookie': this.cookies, 'ContentType': 'application/json; charset=UTF-8'};
  var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxgetcontact?'+querystring.unescape(querystring.stringify(query_dic));
  request.get({url:url, headers:headers}, (function(error, response, body){
    body_dic = JSON.parse(body);
    this._parse_contact(body_dic['MemberList'], body_dic['MemberCount']);
  }).bind(this));
}

WxClient.prototype._wx_bath_get_contact = function(group_list) {
  var query_dic = { "type": "ex",
                    "pass_ticket": this.pass_ticket,
                    "r": Date.now()
                  };
  var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxbatchgetcontact?'+querystring.unescape(querystring.stringify(query_dic));
  var groupList = [];
  for(var i=0; i<group_list.length; i++) {
    groupList.push({'UserName': group_list[i], 'ChatRoomId':''});
  }
  var post_dic = {'BaseRequest': {
                                "DeviceID": this.deviceid,
                                "Sid": this.sid,
                                "Skey": this.skey,
                                "Uin": this.uin,
                              },
                  'Count': groupList.length,
                  'List': groupList,
                };
  var headers = {'Cookie': this.cookies, 'ContentType': 'application/json; charset=UTF-8'};
  request.post({url:url, headers:headers, body:JSON.stringify(post_dic)}, (function(error, response, body){
    body_dic = JSON.parse(body);
    if(body_dic['BaseResponse']['Ret'] == 0) {
      for(var i=0, len=body_dic['Count']; i<len; i++) {
        var userName = body_dic['ContactList'][i]['UserName'];
        for(var j=0, len_j=body_dic['ContactList'][i]['MemberCount']; j<len_j; j++) {
          var userNameInGroup = body_dic['ContactList'][i]['MemberList'][j]['UserName'];
          this.members[userNameInGroup] = body_dic['ContactList'][i]['MemberList'][j];
        }
      }
    }
  }).bind(this));
}

WxClient.prototype._wx_form_syncStr = function() {
  var syncStr='';
  for(var i=0; i<parseInt(this.syncKey['Count']); i++) {
    syncStr+=this.syncKey['List'][i]['Key']+'_'+this.syncKey['List'][i]['Val'];
    if(i!=parseInt(this.syncKey['Count'])-1)
      syncStr+='|';
  }
  this.syncStr = syncStr;
}

WxClient.prototype._wx_sync_check = function() {
  var query_dic={'r': Date.now(),
                'skey': this.skey,
                'sid':this.sid,
                'uin':this.uin,
                'deviceid':this.deviceid,
                'synckey':this.syncStr,
                '_': Date.now()}
  var url = 'https://webpush.weixin.qq.com/cgi-bin/mmwebwx-bin/synccheck?'+querystring.stringify(query_dic);
  var headers = {'Referer':'https://wx.qq.com/', 'Cookie': this.cookies};
  request.get({url:url, headers:headers}, (function(error, response, body){
    if(error) {
      console.log(error);
      return;
    }
    else {
      if(response.statusCode!=200)
        return console.log('Invaild Status code:', response.statusCode);
      var r = body.match(/window\.synccheck={retcode:"(\d+)",selector:"(\d+)"}/);
      retcode = r[1];
      selector = r[2];
      if(retcode=='1100') {
        console.log("[*] 你在手机上登出了微信，再见！");
        this.online = 0;
        clearInterval(this._intervalTimer);
      }
      else if(retcode=='1101') {
        console.log("[*] 你在其他地方登录了web微信，再见！");
        this.online = 0;
        clearInterval(this._intervalTimer);
      }
      else if(retcode=='0') {
        if(selector=='2'){
          console.log("[*] 收到了新消息");
          this._wx_sync();
        }
        else if(selector=='0') {

        }
      }
      else {
        console.log("[*] 出现了严重错误");
        this.online = 0;
        clearInterval(this._intervalTimer);
      }
    }
  }).bind(this));
}

WxClient.prototype._wx_sync = function() {
  var query_dic = {
              'sid': this.sid,
              'skey': this.skey,
              'pass_ticket': this.pass_ticket,
              'r': Date.now()
  }
  var url = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxsync?'+querystring.stringify(query_dic);

  var data= { "BaseRequest" :
                  {"Uin": this.uin,
                  "Sid": this.sid},
                  "SyncKey": this.syncKey,
                  "rr": Date.now()};
  request.post({url:url, body: JSON.stringify(data)}, (function(error, response, body){
    msgBody=JSON.parse(body);
    if(msgBody['BaseResponse']['Ret'] == 0) {
      this.syncKey = msgBody['SyncKey'];
      this._wx_form_syncStr();
      this._handle_msg(msgBody['AddMsgList']);
    }
  }).bind(this));
  }

WxClient.prototype._handle_msg = function(msgs) {
  for(var i=0, len=msgs.length; i<len; i++) {
    var msgType = msgs[i]['MsgType'];
    var name = this._get_user_remark_name(msgs[i]['FromUserName']);
    var msgId = msgs[i]['MsgId'];
    var content = querystring.unescape(msgs[i]['Content']);

    switch (msgType) {
      case 1:
        this._show_msg(msgs[i]);
        break;
      case 3:
        console.log('[*] %s: 发送了一张图片，暂不支持，请前往手机查看', name);
        break;
      case 34:
        console.log('[*] %s: 发送了一段语音，暂不支持，请前往手机查看', name);
        break;
      case 42:
        console.log('[*] %s: 发送了一张名片，暂不支持，请前往手机查看', name);
        break;
      case 47:
        console.log('[*] %s: 发送了一个表情，暂不支持，请前往手机查看', name);
        break;
      case 49:
        console.log(msgs[i]);
        console.log('\t= 标题: %s', msgs[i]['FileName']);
        console.log('\t= 链接: %s', msgs[i]['Url']);
        console.log('[*] %s: 分享了一个链接，请粘贴url到浏览器查看', name);
        var blog = {'tittle': msgs[i]['FileName'],
                    'url': msgs[i]['Url']};
        this.blogList.addBlog(this._get_user_remark_name(msgs[i]['FromUserName']), blog);
        break;
      case 51:
        console.log('[*] 获取了联系人信息');
        this._update_contact(msgs[i]['ToUserName']);
        break;
      case 62:
        console.log('[*] %s: 发送了一段视频，暂不支持，请前往手机查看', name);
        break;
      case 10002:
        console.log('[*] %s: 撤回了一条消息', name);
        break;
      default:
        console.log('[*] 发现未定义的msgType %d', msgType);
        console.log('[*] %s', msgs[i]);

    }
  }
}

WxClient.prototype._show_msg = function(msg) {
  if(msg) {
    var srcName = this._get_user_remark_name(msg['FromUserName']);
    var dstName = this._get_user_remark_name(msg['ToUserName']);
    var content = msg['Content'];
    var msg_id = msg['MsgId'];

    console.log('%s -> %s: %s', srcName, dstName, content);
  }
}

WxClient.prototype._get_user_remark_name = function(userName) {
  if(userName.indexOf('@@')==0 && userName in this.groups) {
    remarkName=this.groups[userName]['RemarkName'];
    remarkName = remarkName ? remarkName : this.groups[userName]['NickName'];
  }
  else if(userName.indexOf('@@')==0 && !(userName in this.groups)) {
    this._wx_bath_get_contact(['userName']);
  }
  else if(userName in this.members){
    remarkName=this.members[userName]['RemarkName'];
    remarkName= remarkName ? remarkName : this.members[userName]['NickName']
  }
  else {

  }

  return remarkName ? remarkName : '未知';
}
module.exports = WxClient;

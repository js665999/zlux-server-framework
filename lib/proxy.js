

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

/**
 * The half of the proxy that talks to the C server
 * 
 */
'use strict';
const http = require('http');
const https = require('https');
const express = require('express');
const util = require('./util');
const unpconst = require('./unp-constants');
const WebSocket = require('ws');
const net = require('net');

const proxyLog = util.loggers.proxyLogger;
const RECONNECT_DELAY = 5000;
const DEFAULT_HANDSHAKE_TIMEOUT = 30000;

function convertOptions(request, realHost, realPort, urlPrefix, requestProcessingOptions) {
  var options = {};
  proxyLog.debug("ZWED0166I", request.headers.host); //proxyLog.debug("request host " + request.headers.host);
  var headers = request.headers;
  var newHeaders = {};
  const headersToRemove = requestProcessingOptions && Array.isArray(requestProcessingOptions.headersToRemove) ? requestProcessingOptions.headersToRemove : undefined;
  for (var propName in headers) {
    if (headers.hasOwnProperty(propName)) {
      proxyLog.debug("ZWED0167I", propName, headers[propName]); //proxyLog.debug("header["+propName+"]="+headers[propName]);
      if (headersToRemove && headersToRemove.indexOf(propName) !== -1) {
        continue;
      }
      if (propName == "host"){
        newHeaders[propName] = realHost+":"+realPort;
      } else if (propName == "origin") {
        newHeaders[propName] = realHost+":"+realPort;
      } else if(propName.startsWith("sec-websocket")) {
        // Drop websocket headers
      } else {
        newHeaders[propName] = headers[propName];
      }
    }
  }
  options.host = realHost;
  options.port = realPort;
  options.family = 4;       /* "rs22" can resolve to IPV6 if otherwise */
  options.headers = newHeaders;
  options.path = urlPrefix + request.url;
  options.method = request.method;
  proxyLog.debug("ZWED0168I", JSON.stringify(options)); //proxyLog.debug("proxied options "+JSON.stringify(options));
  return options;
}

function makeSimpleProxy(host, port, options, pluginID, serviceName) {
  if (!(host && port)) {
    throw new Error(`ZWED0047E - Proxy (${pluginID}:${serviceName}) setup failed.\n`
                    + `Host & Port for proxy destination are required but were missing.\n`
                    + `For information on how to configure a proxy service, see the Zowe wiki on dataservices `
                    + `(https://github.com/zowe/zlux/wiki/ZLUX-Dataservices)`);
  }
  const {urlPrefix, isHttps, addProxyAuthorizations, processProxiedHeaders, allowInvalidTLSProxy, tlsOptions, requestProcessingOptions} = 
    options;
  const httpApi = isHttps? https : http;
  return function(req1, res1) {
    proxyLog.debug("ZWED0169I", req1.protocol, req1.get('host'), req1.url); //proxyLog.debug("Request: " + req1.protocol + '://' + req1.get('host') + req1.url);
    const requestOptions = convertOptions(req1, host, port, urlPrefix, requestProcessingOptions);
    if (isHttps) {
      requestOptions.rejectUnauthorized = !allowInvalidTLSProxy;
      if (tlsOptions) {
        Object.assign(requestOptions, tlsOptions);
      }
    }
    proxyLog.debug(`ZWED0170I`, requestOptions.host, requestOptions.port, requestOptions.path); //proxyLog.debug(`proxy request to ${requestOptions.host}:${requestOptions.port}`
        //+`${requestOptions.path}`);
    if (addProxyAuthorizations) {
      proxyLog.debug('ZWED0171I'); //proxyLog.debug('Callservice: given auth helper ');
      addProxyAuthorizations(req1, requestOptions);
    } else {
      proxyLog.debug('ZWED0172I'); //proxyLog.debug('Callservice: no auth helper');
    }

    const req2 = httpApi.request(requestOptions, (res2) => {
      proxyLog.debug("ZWED0173I", res2.statusCode); //proxyLog.debug("status code" + res2.statusCode);
      res1.status(res2.statusCode);
      const headers = processProxiedHeaders ? 
            processProxiedHeaders(req1, res2.headers) :
            res2.headers;
      
      for (const header of Object.keys(headers)) {
        if (header == 'location') {
          const location = headers[header];
          let pattern = /^http.+\/ZLUX\/plugins\/.+/;
          if (!pattern.test(headers[header])) {
            if (location.startsWith('/')) {
	            res1.set(header, `${req1.protocol}://${req1.get('host')}/ZLUX/plugins/${pluginID}/services/${serviceName}/_current${location}`);
            }
            else if (location.startsWith('http')) {
	            const locationParts = location.split(":");
              let part;
	            if (locationParts.length > 2) {
	              part = locationParts[2];
              } else {
                part = locationParts[1]
              }
              const t = part.indexOf('/');
              const newEnd = part.substring(t);
              const newRedirect = req1.protocol + '://' + req1.get('host') + "/ZLUX/plugins/" + pluginID + "/services/_current" + serviceName + newEnd; 
              proxyLog.debug('ZWED0174I', newRedirect); //proxyLog.debug('Redirecting to: ' + newRedirect);
              res1.set(header, newRedirect);
            }            
          }
        }
        else {
          res1.set(header, headers[header])
        }
      }
      res2.pipe(res1);
    });
    req2.on('error', (e) => {
      proxyLog.warn('ZWED0040W', requestOptions.host, requestOptions.port, requestOptions.path, e); //proxyLog.warn('Callservice: Service call to ... failed.');
      res1.status(500).end();
    });
    if ((req1.method == 'POST') || (req1.method == 'PUT') || (req1.method == 'PATCH')) {
      proxyLog.debug('ZWED0175I'); //proxyLog.debug('Callservice: Forwarding request body to service');
      req1.pipe(req2);
    } else {
      proxyLog.debug('ZWED0176I'); //proxyLog.debug('Callservice: Issuing request to service');
      req2.end();
    }
  }
}

function makeWsProxy(host, port, urlPrefix, options) {
  // copied and pasted with only minimal fixes to formatting
  var toString = function() {
    return '[Proxy URL: '+urlPrefix+']';
  };

  var logException = function(e) {
    proxyLog.warn("ZWED0041W", toString(), e.message); //proxyLog.warn(toString()+' Exception caught. Message='+e.message);
    proxyLog.warn("ZWED0042W", e.stack); //proxyLog.warn("Stack trace follows\n"+e.stack);
  };

  var handleProxyWSException = function(e, ws, proxyws) {
    logException(e);
    try {
      if (ws) {
        ws.close(unpconst.WEBSOCKET_CLOSE_INTERNAL_ERROR,
                 JSON.stringify({error: 'Internal Server Error'}));
      }
      if (proxyws) {
        proxyws.close(unpconst.WEBSOCKET_CLOSE_INTERNAL_ERROR,
                      JSON.stringify({error: 'Internal Server Error'}));
      }
    } catch (closeEx) {
      logException(closeEx);
    }
  };
  return function(ws, req) {
    proxyLog.debug("ZWED0177I", toString(), req.originalUrl); //proxyLog.debug(toString()+" WS proxy request to: " + req.originalUrl);
    if (req.originalUrl.indexOf('?') !== -1) {
      const parts = req.originalUrl.split('?');
      req.originalUrl = parts[0].substring(0, parts[0].length - ".websocket".length)
        + "?" + parts[1];
        proxyLog.debug("ZWED0178I", req.originalUrl); //proxyLog.debug("t:" + req.originalUrl);
    } else {
      req.originalUrl = req.originalUrl.substring(0, req.originalUrl.length
          - ".websocket".length);
          proxyLog.debug("ZWED0179I", req.originalUrl); //proxyLog.debug("s:" + req.originalUrl);
    }
    var requestOptions = convertOptions(req, host, port, urlPrefix);
    const { isHttps, tlsOptions, allowInvalidTLSProxy } = options;
    if (isHttps) {
      requestOptions.rejectUnauthorized = !allowInvalidTLSProxy;
      if (tlsOptions) {
        Object.assign(requestOptions, tlsOptions);
      }
    }
    var targetUrl = url.format({protocol: isHttps ? "wss:" : "ws:",
      slashes: true,
      hostname: requestOptions.host,
      port: requestOptions.port,
      pathname: requestOptions.path});
    requestOptions.url = targetUrl;
    var proxyWs = new WebSocket(targetUrl, requestOptions);
    var proxyOpen = false;
    var bufferedMessages = [];
    var handleBufferedMessages = function() {
      if (bufferedMessages && bufferedMessages.length > 0) {
        for (var i = 0; i < bufferedMessages.length; i++) {
          var bufferedMessage = bufferedMessages[i];
          proxyWs.send(bufferedMessage.data, {
            binary: bufferedMessage.binary,
            mask: bufferedMessage.masked
          });
        }
        bufferedMessages = null;
      }
    };
    ws.on('message', function(data, flags) {
      if (!proxyOpen) {
        bufferedMessages.push({data:data, flags:flags});
      }
      else {
        try {
          handleBufferedMessages();
          proxyWs.send(data, {
            binary: flags.binary,
            mask: flags.masked
          });
        } catch (e) {
          handleProxyWSException(e,ws,proxyWs);
          bufferedMessages = null;
        }
      }
    });
    ws.on('close', function(code, reason) {
      proxyLog.debug('ZWED0180I', code); //proxyLog.debug('ws Seen close with code='+code);
      if (code < unpconst.WEBSOCKET_CLOSE_CODE_MINIMUM) {
        //application-level code is not allowed to issue a close
        //command with values under 4000, and library level not under 3000.
        code =  unpconst.WEBSOCKET_CLOSE_BY_PROXY;
      }
      try {
        proxyWs.close(code, reason);
      } catch (e) {
        handleProxyWSException(e,ws,null);
      }
    });
    ws.on('ping', function(data, flags) {
      try {
        proxyWs.ping(data, flags.masked);
      } catch (e) {
        handleProxyWSException(e,ws,proxyWs);
      }
    });
    ws.on('pong', function(data, flags) {
      try {
        proxyWs.pong(data, flags.masked);
      } catch (e) {
        handleProxyWSException(e,ws,proxyWs);
      }
    });
    proxyWs.on('open', function open() {
      try {
        handleBufferedMessages();
        proxyOpen = true;
      } catch (e) {
        handleProxyWSException(e,ws,proxyWs);
        bufferedMessages = null;
      }
      if (proxyOpen) {
        proxyWs.on('close', function(code, reason) {
          proxyLog.debug('ZWED0181I', code); //proxyLog.debug('proxyws Seen close with code='+code);
          if (code < unpconst.WEBSOCKET_CLOSE_CODE_MINIMUM) {
            //application-level code is not allowed to issue a close
            //command with values under 4000, and library level not under 3000.
            code = unpconst.WEBSOCKET_CLOSE_BY_PROXY;
          }
          try {
            ws.close(code, reason);
          } catch (e) {
            handleProxyWSException(e,null,proxyWs);
          }
        });
        proxyWs.on('message', function(data, flags) {
          try {
            ws.send(data, {
              binary: flags.binary,
              mask: flags.masked
            });
          } catch (e) {
            handleProxyWSException(e,ws,proxyWs);
          }
        });
        proxyWs.on('ping', function(data, flags) {
          try {
            ws.ping(data, flags.masked);
          } catch (e) {
            handleProxyWSException(e,ws,proxyWs);
          }
        });
        proxyWs.on('pong', function(data, flags) {
          try {
            ws.pong(data, flags.masked);
          } catch (e) {
            handleProxyWSException(e,ws,proxyWs);
          }
        });
      }
    });
    proxyWs.on('error', function(error) {
      proxyLog.warn("ZWED0043W", toString(), error); //proxyLog.warn(toString()+" proxyWS error:" + error);
      if (ws) {
        ws.terminate();
      }
      proxyWs.terminate();
      bufferedMessages = null;
    });
    ws.on('error', function(error) {
      proxyLog.warn("ZWED0044W", toString(), error); //proxyLog.warn(toString()+" WS error:" + error);
      if (proxyWs) {
        proxyWs.terminate();
      }
      ws.terminate();
      bufferedMessages = null;
    });
  };
};

function checkProxiedHost(host, port, handshakeTimeout) {
  const client = new net.Socket();
  let timeLeft = handshakeTimeout ? handshakeTimeout : DEFAULT_HANDSHAKE_TIMEOUT;
  return new Promise((resolve, reject) => {
    const connect = () => {
      client.connect(port, host)
      timeLeft = timeLeft - RECONNECT_DELAY;
    }

    client.once("connect", () => {
      client.destroy();
      resolve();
    });

    client.on('error', (e) => {
      if (timeLeft <= 0) {
        proxyLog.warn(`ZWED0045W`, host, port); //proxyLog.warn(`Failed to reach the auth services host for address ${host}:${port}`);
        if (host === '127.0.0.1') {
          proxyLog.warn("ZWED0046W"); //proxyLog.warn("The auth services host system was not " +
          //"specified at startup, and defaulted to 127.0.0.1.\n" +
          //"Verify that the auth services server is running, " +
          //"or specify at startup the remote host and port to connect to. " +
          //"See documentation for details.");
        }
        reject(`Communication with ${host}:${port} failed: ${e.toString()}`);
      } else if (e.code == 'ECONNREFUSED') {
        proxyLog.warn("Failed to connect to the server, will attempt again...")
        setTimeout(connect, RECONNECT_DELAY)
      }
    });

    connect();
  });
}

exports.makeSimpleProxy = makeSimpleProxy;
exports.makeWsProxy = makeWsProxy;
exports.checkProxiedHost = checkProxiedHost;


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/


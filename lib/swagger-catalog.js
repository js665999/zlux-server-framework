
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/


const express = require('express');
const Promise = require('bluebird');
const zLuxUrl = require('./url')
const path = require('path');
const fs = require('fs');
const yaml = require('yaml');
const swaggerParser = require('swagger-parser')
const os = require('os');
const zluxUtil = require('./util');

var installLog = zluxUtil.loggers.installLogger;

function getServiceSummary(service) {
  switch (service.type) {
  case "router":
  case "nodeService":
    return `${service.name} node service`
  case "external":
    return `proxy of ${service.isHttps ? 'https://' : 'http://'}${service.host}:${service.port}${service.urlPrefix?
                                                                                                 service.urlPrefix:''}`;
  case "import":
    return `import of ${service.sourcePlugin}:${service.sourceName}`;
  default:
    return `${service.name} data service`
  }
}

const makeCatalogForPlugin = () => {
  let allServerDocs = [];
  var getAllZLUXDocs = (zluxServerDocs) => {
      let openApi = zluxServerDocs.pluginCatalog;
      allServerDocs.forEach((serviceSwagger)=> {
      let servicePaths = serviceSwagger.paths;
      for (let route in servicePaths) {
        let servicePrefixedRoute = `${serviceSwagger.basePath}${route}`;
        openApi.paths[servicePrefixedRoute] = servicePaths[route];
      }
      });
      zluxServerDocs.serviceDocs.concat(allServerDocs);
      return zluxServerDocs;
  }

  return (plugin, productCode, serverConfig) => {
    return new Promise((resolve) => {
      const nodeContext = serverConfig.components['app-server'].node;
      const openApi = {
        swagger: "2.0",
        info: {
          title:  plugin.identifier,
          description: plugin.webContent ? plugin.webContent.descriptionDefault : undefined,
          version: plugin.pluginVersion || "0.0.1",
          license: plugin.license
        },
        basePath: zLuxUrl.makePluginURL(productCode, plugin.identifier) + "/services",
        host: getHost(serverConfig),
        schemes: getSchemesFromContext(nodeContext),
        paths: {}
      };

      overwriteSwaggerFieldsForExternal(openApi, plugin);
      let isExternal = zluxUtil.isPluginExternal(plugin);

      getSwaggerDocs(plugin, productCode, serverConfig)
      .then((swaggerDocs) => {

        swaggerDocs.forEach((service)=> {
          const servicePaths = service.serviceDoc.paths;
          let version = service.serviceVersion;
          let skipRouteServicePrefix = isExternal;
          for (let route in servicePaths) {
            let servicePrefixedRoute = `${skipRouteServicePrefix?'':`/${service.serviceName}/${version}`}${route}`;
            openApi.paths[servicePrefixedRoute] = servicePaths[route];
          }
        });

        for (const service of plugin.dataServices || []) {
          //Missing swagger should get a placeholder
          //TODO we can actually somewhat inspect Express routers
          const servicePath = (zLuxUrl.makeServiceSubURL(service) + '/').substring(9);
          if (Object.keys(openApi.paths).length == 0) {
            openApi.paths[servicePath] = {
              get: {
                summary: getServiceSummary(service),
                responses: {
                  200: {
                    description: "This is a placeholder because the plugin did not supply a swagger document"
                  }
                }
              }
            };
          }
        }
        // pass everything back at once the plugin catalog with all services together
        // swaggerdocs is the list of all the docs for each service
        var allDocumentation = {
          pluginCatalog: openApi,
          serviceDocs: swaggerDocs
        }
        return allDocumentation;
      }).then(async (allDocumentation) => {
        if(!isExternal) {
          allServerDocs.push(allDocumentation.pluginCatalog);
        }
        if(plugin.identifier === zluxUtil.serverSwaggerPluginId) {
          allDocumentation = getAllZLUXDocs(allDocumentation);
        } 
        resolve(allDocumentation);
      })
    })
  }
}



var getSwaggerDocs = Promise.coroutine(function* (plugin, productCode, zoweConfig) {
  var allServiceDocs = [];
  if (plugin.dataServices) {
    let serviceList = plugin.dataServices;

    for (let i = 0; i < serviceList.length; i++) {
      let service = serviceList[i];
      if (service.type === 'import') {
        continue; //resolve later in load process
      }
      installLog.debug(`ZWED0182I`, plugin.identifier, service.name); //installLog.debug(`Reading swagger for ${plugin.identifier}:${service.name}`);
      let fileContent;
      try {
        fileContent = yield readSingleSwaggerFile(path.join(plugin.location, "doc/swagger"),
                                                  service.name,
                                                  service.version);
      } catch (err) {
        if (err.code === 'ENOENT') {
          installLog.debug(`ZWED0047W`, plugin.identifier, service.name); //installLog.warn(`Swagger file for service (${plugin.identifier}:${service.name}) not found`);
        } else {
          installLog.debug(err);
          installLog.warn(`ZWED0048W`, plugin.identifier, service.name); //installLog.warn(`Invalid Swagger from file for service (${plugin.identifier}:${service.name})`);
          installLog.warn("ZWED0049W", err.message, err.stack); //installLog.warn(err);
        }
      }
      if (fileContent) {
        fileContent = overwriteSwaggerFieldsForServer(fileContent,
                                                      zLuxUrl.makePluginURL(productCode, plugin.identifier),
                                                      zoweConfig);
        fileContent = overwriteSwaggerFieldsForExternal(fileContent, service);

        allServiceDocs.push({
          "serviceName" : service.name,
          "serviceVersion": service.version,
          "serviceDoc" : fileContent
        });
      }
    }
  }
  return allServiceDocs;
})

function readSingleSwaggerFile (dirName, serviceName, serviceVersion) {
  // read one swagger file and validate the json that is returned
  return new Promise ((resolve, reject) => {
    const jsonName = serviceName+'.json';
    const jsonNameV = serviceName+'_'+serviceVersion+'.json';
    const yamlName = serviceName+'.yaml';
    const yamlNameV = serviceName+'_'+serviceVersion+'.yaml';
    let swaggerPath;
    
    fs.readdir(dirName,(err, files)=> {
      if (err) {
        installLog.debug(`ZWED0050W`, dirName); //installLog.warn(`Could not read swagger doc folder ${dirName}`);
        return reject(err);
      } else {
        let bestPath = undefined;
        for (let i = 0; i < files.length; i++) {
          if (files[i] == jsonNameV) {
            bestPath = jsonNameV;
            //ideal
            break;
          } else if (files[i] == jsonName) {
            bestPath = jsonName;
          } else if (files[i] == yamlNameV) {
            bestPath = yamlNameV;
          } else if (files[i] == yamlName) {
            bestPath = yamlName;
          }
        }
        if (bestPath) {
          swaggerPath = path.join(dirName, bestPath);
          installLog.debug(`ZWED0183I`, swaggerPath); //installLog.debug(`Reading swagger at path=${swaggerPath}`);
          fs.readFile(swaggerPath,{encoding:'utf-8'},(err, fileContent)=> {
            if (err) {
              return reject(err);
            }
            let swaggerJson = yaml.parse(fileContent);
            swaggerParser.validate(swaggerJson).then(function(valid) {
              return resolve(swaggerJson)
            }).catch(function(err) {
              return reject(err.message)
            });
          });          
        } else {
          return reject({code: 'ENOENT', message: `No swagger found`});
        }
      }
    });
  });
}

function overwriteSwaggerFieldsForExternal(swaggerJson, serviceOrPlugin) {
  let service = serviceOrPlugin;
  if((serviceOrPlugin.constructor.name === 'ApplicationPlugIn')
    && serviceOrPlugin.dataServices 
    && (serviceOrPlugin.dataServices.length > 0) ) {
    service = serviceOrPlugin.dataServices[0];
  }

  if(service.type === 'external') {
    swaggerJson.basePath = service.urlPrefix || swaggerJson.basePath;
    swaggerJson.host = service.host + ':' + service.port;
    swaggerJson.schemes = [service.isHttps?'https':'http'];
  }
  return swaggerJson;
}

function overwriteSwaggerFieldsForServer (swaggerJson, urlBase, nodeContext) {
  // overwrite swagger fields with more accurate info from server and config
  swaggerJson.basePath = urlBase + "/services" + swaggerJson.basePath
    + (swaggerJson.basePath.endsWith('/')?"":"/") + swaggerJson.info.version;
  swaggerJson.schemes = getSchemesFromContext(nodeContext);
  swaggerJson.host = getHost(nodeContext);
  return swaggerJson;
}

function getSchemesFromContext (nodeContext) {
  let schemes = [];
  if (nodeContext.http) {
    schemes.push("http");
  }
  if (nodeContext.https) {
    schemes.push("https");
  }
  return schemes;
}

//TODO this seems like an action done in other places too. unify under utils?
function getHost(zoweConfig) {
  return `${zluxUtil.getBestHostname(zoweConfig)}:${zluxUtil.getBestPort(zoweConfig)}`;
}

module.exports = makeCatalogForPlugin();

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

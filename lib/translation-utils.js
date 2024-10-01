/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

'use strict';
const path = require('path');
const fs = require('fs');
const jsonUtils = require('./jsonUtils.js');
const zluxUtil = require('./util');
const acceptLanguageParser = require('accept-language-parser');

const utilLog = zluxUtil.loggers.utilLogger;

/* loadTranslations reads pluginDefinition.i18n.{lang}-{Country}.json files
/  for a given plugin location.
/ 
/  Returns translation maps:
/  {
/    '{lang}-{Country}': {
/      'key': 'value',
/      ...
/    },
/    ...
/  }
*/
function loadTranslations(pluginLocation) {
  const translationMaps = {};
  const filePrefix = 'pluginDefinition.i18n.';
  const fileExt = '.json';
  const folder = path.join(pluginLocation, 'web/assets/i18n');
  let files = [];
  try {
    files = fs.readdirSync(folder)
          .filter((filename)=> {
            return filename.startsWith(filePrefix) && filename.endsWith(fileExt);
          })
          .map((filename)=> {
            return path.join(folder, filename);
          });
  } catch (e) {
    //A plugin may not have translations and that is OK.
    return translationMaps;
  }
  for (const file of files) {
    const basename = path.basename(file);
    const languageCountry = basename.substring(
      filePrefix.length,
      basename.length - fileExt.length
    );
    let content;
    try {
      content = jsonUtils.parseJSONWithComments(file);
    } catch (e) {
      utilLog.warn(`ZWED0051W`, file); //utilLog.warn(`Failed to parse translation file ${file}. File skipped`);
      continue;
    }
    translationMaps[languageCountry] = content;
  }
  return translationMaps;
}

// translate translates Plugin Definition choosing most suitable translation map
function translate(pluginDef, translationMaps, acceptLanguage) {
  const availableTranslations = getAvailableTranslations(translationMaps);
  const langCountry = acceptLanguageParser.pick(
    availableTranslations,
    acceptLanguage
  );
  if (!langCountry) {
    return pluginDef;
  }
  const pluginDefClone = zluxUtil.clone(pluginDef);
  const webContent = pluginDefClone.webContent;
  const translationMap = translationMaps[langCountry];
  translateObject(webContent, translationMap);
  return pluginDefClone;
}

// getAcceptLanguageFromCookies builds acceptLanguage string
// based on user preferences stored in cookies
function getAcceptLanguageFromCookies(cookies) {
  const prefix = 'org.zowe.zlux.zlux-app-manager.preferences';
  const languageKey = `${prefix}.language`;
  // ex.: 'es-ES' or 'es'
  const language = cookies[languageKey];
  if (!language) {
    return null;
  }
  const baseLanguage = getBaseLanguage(language);
  if (baseLanguage != language) {
    return `${language},${baseLanguage}`;
  }
  return language;
}

function getBaseLanguage(language) {
  return language.split('-')[0];
}

function getAvailableTranslations(translationMaps) {
  return Object.keys(translationMaps);
}

function translateObject(object, translationMap) {
  for (const key in object) {
    if (key.endsWith('Key') && typeof object[key] === 'string') {
      const keyToTranslate = key.substr(0, key.length - 3) + 'Default';
      const translationKey = object[key];
      const translated = translationMap[translationKey];
      if (
        typeof object[keyToTranslate] === 'string' &&
        typeof translated === 'string'
      ) {
        object[keyToTranslate] = translated;
      }
    } else {
      if (typeof object[key] === 'object') {
        translateObject(object[key], translationMap);
      }
    }
  }
}

module.exports = {
  getAcceptLanguageFromCookies,
  loadTranslations,
  translate
};

const _unitTest = false;
function unitTest() {
  const location = '../../sample-app/';
  const pluginDefinitionFile = path.join(location, 'pluginDefinition.json');
  const pluginDefinition = jsonUtils.parseJSONWithComments(pluginDefinitionFile);
  pluginDefinition.location = location;
  const acceptLanguage = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7,en-GB;q=0.6';
  const translationMaps = loadTranslations(location);
  const translatedPluginDefinition = translate(
    pluginDefinition,
    translationMaps,
    acceptLanguage
  );
  console.log(JSON.stringify(translationMaps, null, 2));
  console.log(JSON.stringify(translatedPluginDefinition, null, 2));
}
if (_unitTest) {
  unitTest();
}

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

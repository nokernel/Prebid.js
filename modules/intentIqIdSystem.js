/**
 * This module adds IntentIqId to the User ID module
 * The {@link module:modules/userId} module is required
 * @module modules/intentIqIdSystem
 * @requires module:modules/userId
 */

import {logError, isPlainObject, isStr, isNumber, getWinDimensions} from '../src/utils.js';
import {ajax} from '../src/ajax.js';
import {submodule} from '../src/hook.js'
import AES from 'crypto-js/aes.js';
import Utf8 from 'crypto-js/enc-utf8.js';
import {detectBrowser} from '../libraries/intentIqUtils/detectBrowserUtils.js';
import {appendSPData} from '../libraries/intentIqUtils/urlUtils.js';
import {appendVrrefAndFui} from '../libraries/intentIqUtils/getRefferer.js';
import { getCmpData } from '../libraries/intentIqUtils/getCmpData.js';
import {readData, storeData, defineStorageType, removeDataByKey, tryParse} from '../libraries/intentIqUtils/storageUtils.js';
import {
  FIRST_PARTY_KEY,
  WITH_IIQ, WITHOUT_IIQ,
  NOT_YET_DEFINED,
  CLIENT_HINTS_KEY,
  EMPTY,
  GVLID,
  VERSION, INVALID_ID, SCREEN_PARAMS, SYNC_REFRESH_MILL, META_DATA_CONSTANT, PREBID,
  HOURS_24
} from '../libraries/intentIqConstants/intentIqConstants.js';
import {SYNC_KEY} from '../libraries/intentIqUtils/getSyncKey.js';
import {iiqPixelServerAddress, iiqServerAddress} from '../libraries/intentIqUtils/intentIqConfig.js';
import { handleAdditionalParams } from '../libraries/intentIqUtils/handleAdditionalParams.js';

/**
 * @typedef {import('../modules/userId/index.js').Submodule} Submodule
 * @typedef {import('../modules/userId/index.js').SubmoduleConfig} SubmoduleConfig
 * @typedef {import('../modules/userId/index.js').IdResponse} IdResponse
 */

const MODULE_NAME = 'intentIqId';

const encoderCH = {
  brands: 0,
  mobile: 1,
  platform: 2,
  architecture: 3,
  bitness: 4,
  model: 5,
  platformVersion: 6,
  wow64: 7,
  fullVersionList: 8
};
let sourceMetaData;
let sourceMetaDataExternal;

let FIRST_PARTY_KEY_FINAL = FIRST_PARTY_KEY;
let PARTNER_DATA_KEY;
let callCount = 0;
let failCount = 0;
let noDataCount = 0;

export let firstPartyData;

/**
 * Generate standard UUID string
 * @return {string}
 */
function generateGUID() {
  let d = new Date().getTime();
  const guid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (d + Math.random() * 16) % 16 | 0;
    d = Math.floor(d / 16);
    return (c == 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  return guid;
}

/**
 * Encrypts plaintext.
 * @param {string} plainText The plaintext to encrypt.
 * @returns {string} The encrypted text as a base64 string.
 */
export function encryptData(plainText) {
  return AES.encrypt(plainText, MODULE_NAME).toString();
}

/**
 * Decrypts ciphertext.
 * @param {string} encryptedText The encrypted text as a base64 string.
 * @returns {string} The decrypted plaintext.
 */
export function decryptData(encryptedText) {
  const bytes = AES.decrypt(encryptedText, MODULE_NAME);
  return bytes.toString(Utf8);
}

function collectDeviceInfo() {
  const windowDimensions = getWinDimensions();
  return {
    windowInnerHeight: windowDimensions.innerHeight,
    windowInnerWidth: windowDimensions.innerWidth,
    devicePixelRatio: windowDimensions.devicePixelRatio,
    windowScreenHeight: windowDimensions.screen.height,
    windowScreenWidth: windowDimensions.screen.width,
    language: navigator.language
  }
}

function addUniquenessToUrl(url) {
  url += '&tsrnd=' + Math.floor(Math.random() * 1000) + '_' + new Date().getTime();
  return url;
}

function appendDeviceInfoToUrl(url, deviceInfo) {
  const screenParamsString = Object.entries(SCREEN_PARAMS)
    .map(([index, param]) => {
      const value = (deviceInfo)[param];
      return `${index}:${value}`;
    })
    .join(',');

  url += `&cz=${encodeURIComponent(screenParamsString)}`;
  url += `&dw=${deviceInfo.windowScreenWidth}&dh=${deviceInfo.windowScreenHeight}&dpr=${deviceInfo.devicePixelRatio}&lan=${deviceInfo.language}`;
  return url;
}

function appendFirstPartyData (url, firstPartyData, partnerData) {
  url += firstPartyData.pid ? '&pid=' + encodeURIComponent(firstPartyData.pid) : '';
  url += firstPartyData.pcid ? '&iiqidtype=2&iiqpcid=' + encodeURIComponent(firstPartyData.pcid) : '';
  url += firstPartyData.pcidDate ? '&iiqpciddate=' + encodeURIComponent(firstPartyData.pcidDate) : '';
  return url
}

function verifyIdType(value) {
  if (value === 0 || value === 1 || value === 3 || value === 4) return value;
  return -1;
}

function appendPartnersFirstParty (url, configParams) {
  const partnerClientId = typeof configParams.partnerClientId === 'string' ? encodeURIComponent(configParams.partnerClientId) : '';
  const partnerClientIdType = typeof configParams.partnerClientIdType === 'number' ? verifyIdType(configParams.partnerClientIdType) : -1;

  if (partnerClientIdType === -1) return url;
  if (partnerClientId !== '') {
    url = url + '&pcid=' + partnerClientId;
    url = url + '&idtype=' + partnerClientIdType;
  }
  return url;
}

function appendCMPData (url, cmpData) {
  url += cmpData.uspString ? '&us_privacy=' + encodeURIComponent(cmpData.uspString) : '';
  url += cmpData.gppString ? '&gpp=' + encodeURIComponent(cmpData.gppString) : '';
  url += cmpData.gdprApplies
    ? '&gdpr_consent=' + encodeURIComponent(cmpData.gdprString) + '&gdpr=1'
    : '&gdpr=0';
  return url
}

function appendCounters (url) {
  url += '&jaesc=' + encodeURIComponent(callCount);
  url += '&jafc=' + encodeURIComponent(failCount);
  url += '&jaensc=' + encodeURIComponent(noDataCount);
  return url
}

/**
 * Translate and validate sourceMetaData
 */
export function translateMetadata(data) {
  try {
    const d = data.split('.');
    return (
      ((+d[0] * META_DATA_CONSTANT + +d[1]) * META_DATA_CONSTANT + +d[2]) * META_DATA_CONSTANT +
      +d[3]
    );
  } catch (e) {
    return NaN;
  }
}

/**
 * Add sourceMetaData to URL if valid
 */
function addMetaData(url, data) {
  if (typeof data !== 'number' || isNaN(data)) {
    return url;
  }
  return url + '&fbp=' + data;
}

export function createPixelUrl(firstPartyData, clientHints, configParams, partnerData, cmpData) {
  const deviceInfo = collectDeviceInfo();
  const browser = detectBrowser();

  let url = iiqPixelServerAddress(configParams, cmpData.gdprString);
  url += '/profiles_engine/ProfilesEngineServlet?at=20&mi=10&secure=1';
  url += '&dpi=' + configParams.partner;
  url = appendFirstPartyData(url, firstPartyData, partnerData);
  url = appendPartnersFirstParty(url, configParams);
  url = addUniquenessToUrl(url);
  url += partnerData?.clientType ? '&idtype=' + partnerData.clientType : '';
  if (deviceInfo) url = appendDeviceInfoToUrl(url, deviceInfo);
  url += VERSION ? '&jsver=' + VERSION : '';
  if (clientHints) url += '&uh=' + encodeURIComponent(clientHints);
  url = appendVrrefAndFui(url, configParams.domainName);
  url = appendCMPData(url, cmpData);
  url = addMetaData(url, sourceMetaDataExternal || sourceMetaData);
  url = handleAdditionalParams(browser, url, 0, configParams.additionalParams);
  url = appendSPData(url, firstPartyData)
  url += '&source=' + PREBID;
  return url;
}

function sendSyncRequest(allowedStorage, url, partner, firstPartyData, newUser) {
  const lastSyncDate = Number(readData(SYNC_KEY(partner) || '', allowedStorage)) || false;
  const lastSyncElapsedTime = Date.now() - lastSyncDate

  if (firstPartyData.isOptedOut) {
    const needToDoSync = (Date.now() - (firstPartyData?.date || firstPartyData?.sCal || Date.now())) > SYNC_REFRESH_MILL
    if (newUser || needToDoSync) {
      ajax(url, () => {
      }, undefined, {method: 'GET', withCredentials: true});
      if (firstPartyData?.date) {
        firstPartyData.date = Date.now()
        storeData(FIRST_PARTY_KEY_FINAL, JSON.stringify(firstPartyData), allowedStorage, firstPartyData);
      }
    }
  } else if (!lastSyncDate || lastSyncElapsedTime > SYNC_REFRESH_MILL) {
    storeData(SYNC_KEY(partner), Date.now() + '', allowedStorage);
    ajax(url, () => {
    }, undefined, {method: 'GET', withCredentials: true});
  }
}

/**
 * Configures and updates A/B testing group in Google Ad Manager (GAM).
 *
 * @param {object} gamObjectReference - Reference to the GAM object, expected to have a `cmd` queue and `pubads()` API.
 * @param {string} gamParameterName - The name of the GAM targeting parameter where the group value will be stored.
 * @param {string} userGroup - The A/B testing group assigned to the user (e.g., 'A', 'B', or a custom value).
 */
export function setGamReporting(gamObjectReference, gamParameterName, userGroup) {
  if (isPlainObject(gamObjectReference) && gamObjectReference.cmd) {
    gamObjectReference.cmd.push(() => {
      gamObjectReference
        .pubads()
        .setTargeting(gamParameterName, userGroup || NOT_YET_DEFINED);
    });
  }
}

/**
 * Processes raw client hints data into a structured format.
 * @param {object} clientHints - Raw client hints data
 * @return {string} A JSON string of processed client hints or an empty string if no hints
 */
export function handleClientHints(clientHints) {
  const chParams = {};
  for (const key in clientHints) {
    if (clientHints.hasOwnProperty(key) && clientHints[key] !== '') {
      if (['brands', 'fullVersionList'].includes(key)) {
        let handledParam = '';
        clientHints[key].forEach((element, index) => {
          const isNotLast = index < clientHints[key].length - 1;
          handledParam += `"${element.brand}";v="${element.version}"${isNotLast ? ', ' : ''}`;
        });
        chParams[encoderCH[key]] = handledParam;
      } else if (typeof clientHints[key] === 'boolean') {
        chParams[encoderCH[key]] = `?${clientHints[key] ? 1 : 0}`;
      } else {
        chParams[encoderCH[key]] = `"${clientHints[key]}"`;
      }
    }
  }
  return Object.keys(chParams).length ? JSON.stringify(chParams) : '';
}

export function isCMPStringTheSame(fpData, cmpData) {
  const firstPartyDataCPString = `${fpData.gdprString}${fpData.gppString}${fpData.uspString}`;
  const cmpDataString = `${cmpData.gdprString}${cmpData.gppString}${cmpData.uspString}`;
  return firstPartyDataCPString === cmpDataString;
}

function updateCountersAndStore(runtimeEids, allowedStorage, partnerData) {
  if (!runtimeEids?.eids?.length) {
    noDataCount++;
  } else {
    callCount++;
  }
  storeCounters(allowedStorage, partnerData);
}

function clearCountersAndStore(allowedStorage, partnerData) {
  callCount = 0;
  failCount = 0;
  noDataCount = 0;
  storeCounters(allowedStorage, partnerData);
}

function storeCounters(storage, partnerData) {
  partnerData.callCount = callCount;
  partnerData.failCount = failCount;
  partnerData.noDataCounter = noDataCount;
  storeData(PARTNER_DATA_KEY, JSON.stringify(partnerData), storage, firstPartyData);
}

/** @type {Submodule} */
export const intentIqIdSubmodule = {
  /**
   * used to link submodule with config
   * @type {string}
   */
  name: MODULE_NAME,
  gvlid: GVLID,
  /**
   * decode the stored id value for passing to bid requests
   * @function
   * @param {{string}} value
   * @returns {{intentIqId: {string}}|undefined}
   */
  decode(value) {
    return value && value != '' && INVALID_ID != value ? {'intentIqId': value} : undefined;
  },

  /**
   * performs action to obtain id and return a value in the callback's response argument
   * @function
   * @param {SubmoduleConfig} [config]
   * @returns {IdResponse|undefined}
   */
  getId(config) {
    const configParams = (config?.params) || {};

    const firePartnerCallback = () => {
      if (configParams.callback && !callbackFired) {
        callbackFired = true;
        if (callbackTimeoutID) clearTimeout(callbackTimeoutID);
        if (isGroupB) runtimeEids = { eids: [] };
        configParams.callback(runtimeEids);
      }
    }

    if (typeof configParams.partner !== 'number') {
      logError('User ID - intentIqId submodule requires a valid partner to be defined');
      firePartnerCallback()
      return;
    }

    let decryptedData, callbackTimeoutID;
    let callbackFired = false;
    let runtimeEids = { eids: [] };

    const gamObjectReference = isPlainObject(configParams.gamObjectReference) ? configParams.gamObjectReference : undefined;
    const gamParameterName = configParams.gamParameterName ? configParams.gamParameterName : 'intent_iq_group';
    const groupChanged = typeof configParams.groupChanged === 'function' ? configParams.groupChanged : undefined;
    const siloEnabled = typeof configParams.siloEnabled === 'boolean' ? configParams.siloEnabled : false;
    sourceMetaData = isStr(configParams.sourceMetaData) ? translateMetadata(configParams.sourceMetaData) : '';
    sourceMetaDataExternal = isNumber(configParams.sourceMetaDataExternal) ? configParams.sourceMetaDataExternal : undefined;
    const additionalParams = configParams.additionalParams ? configParams.additionalParams : undefined;
    PARTNER_DATA_KEY = `${FIRST_PARTY_KEY}_${configParams.partner}`;

    const allowedStorage = defineStorageType(config.enabledStorageTypes);

    let rrttStrtTime = 0;
    let partnerData = {};
    let shouldCallServer = false;
    FIRST_PARTY_KEY_FINAL = `${FIRST_PARTY_KEY}${siloEnabled ? '_p_' + configParams.partner : ''}`;
    const cmpData = getCmpData();
    const gdprDetected = cmpData.gdprString;
    firstPartyData = tryParse(readData(FIRST_PARTY_KEY_FINAL, allowedStorage));
    const isGroupB = firstPartyData?.group === WITHOUT_IIQ;
    setGamReporting(gamObjectReference, gamParameterName, firstPartyData?.group);

    if (groupChanged) groupChanged(firstPartyData?.group || NOT_YET_DEFINED);

    callbackTimeoutID = setTimeout(() => {
      firePartnerCallback();
    }, configParams.timeoutInMillis || 500
    );

    const currentBrowserLowerCase = detectBrowser();
    const browserBlackList = typeof configParams.browserBlackList === 'string' ? configParams.browserBlackList.toLowerCase() : '';
    let newUser = false;

    if (!firstPartyData?.pcid) {
      const firstPartyId = generateGUID();
      firstPartyData = {
        pcid: firstPartyId,
        pcidDate: Date.now(),
        group: NOT_YET_DEFINED,
        uspString: EMPTY,
        gppString: EMPTY,
        gdprString: EMPTY,
        date: Date.now()
      };
      newUser = true;
      storeData(FIRST_PARTY_KEY_FINAL, JSON.stringify(firstPartyData), allowedStorage, firstPartyData);
    } else if (!firstPartyData.pcidDate) {
      firstPartyData.pcidDate = Date.now();
      storeData(FIRST_PARTY_KEY_FINAL, JSON.stringify(firstPartyData), allowedStorage, firstPartyData);
    }

    if (gdprDetected && !('isOptedOut' in firstPartyData)) {
      firstPartyData.isOptedOut = true;
    }

    // Read client hints from storage
    let clientHints = readData(CLIENT_HINTS_KEY, allowedStorage);

    // Get client hints and save to storage
    if (navigator?.userAgentData?.getHighEntropyValues) {
      navigator.userAgentData
        .getHighEntropyValues([
          'brands',
          'mobile',
          'bitness',
          'wow64',
          'architecture',
          'model',
          'platform',
          'platformVersion',
          'fullVersionList'
        ])
        .then(ch => {
          clientHints = handleClientHints(ch);
          storeData(CLIENT_HINTS_KEY, clientHints, allowedStorage, firstPartyData)
        });
    }

    const savedData = tryParse(readData(PARTNER_DATA_KEY, allowedStorage))
    if (savedData) {
      partnerData = savedData;

      if (typeof partnerData.callCount === 'number') callCount = partnerData.callCount;
      if (typeof partnerData.failCount === 'number') failCount = partnerData.failCount;
      if (typeof partnerData.noDataCounter === 'number') noDataCount = partnerData.noDataCounter;

      if (partnerData.wsrvcll) {
        partnerData.wsrvcll = false;
        storeData(PARTNER_DATA_KEY, JSON.stringify(partnerData), allowedStorage, firstPartyData);
      }
    }

    if (partnerData.data) {
      if (partnerData.data.length) { // encrypted data
        decryptedData = tryParse(decryptData(partnerData.data));
        runtimeEids = decryptedData;
      }
    }

    if (!isCMPStringTheSame(firstPartyData, cmpData) ||
          !firstPartyData.sCal ||
          (savedData && (!partnerData.cttl || !partnerData.date || Date.now() - partnerData.date > partnerData.cttl))) {
      firstPartyData.uspString = cmpData.uspString;
      firstPartyData.gppString = cmpData.gppString;
      firstPartyData.gdprString = cmpData.gdprString;
      shouldCallServer = true;
      storeData(FIRST_PARTY_KEY_FINAL, JSON.stringify(firstPartyData), allowedStorage, firstPartyData);
      storeData(PARTNER_DATA_KEY, JSON.stringify(partnerData), allowedStorage, firstPartyData);
    }
    if (!shouldCallServer) {
      if (!savedData && !firstPartyData.isOptedOut) {
        shouldCallServer = true;
      } else shouldCallServer = Date.now() > firstPartyData.sCal + HOURS_24;
    }

    if (firstPartyData.isOptedOut) {
      partnerData.data = runtimeEids = { eids: [] };
      firePartnerCallback()
    }

    if (firstPartyData.group === WITHOUT_IIQ || (firstPartyData.group !== WITHOUT_IIQ && runtimeEids?.eids?.length)) {
      firePartnerCallback()
    }

    // Check if current browser is in blacklist
    if (browserBlackList?.includes(currentBrowserLowerCase)) {
      logError('User ID - intentIqId submodule: browser is in blacklist! Data will be not provided.');
      if (configParams.callback) configParams.callback('');
      const url = createPixelUrl(firstPartyData, clientHints, configParams, partnerData, cmpData)
      sendSyncRequest(allowedStorage, url, configParams.partner, firstPartyData, newUser)
      return
    }

    if (!shouldCallServer) {
      if (isGroupB) runtimeEids = { eids: [] };
      firePartnerCallback();
      updateCountersAndStore(runtimeEids, allowedStorage, partnerData);
      return { id: runtimeEids.eids };
    }

    // use protocol relative urls for http or https
    let url = `${iiqServerAddress(configParams, gdprDetected)}/profiles_engine/ProfilesEngineServlet?at=39&mi=10&dpi=${configParams.partner}&pt=17&dpn=1`;
    url += configParams.pai ? '&pai=' + encodeURIComponent(configParams.pai) : '';
    url = appendFirstPartyData(url, firstPartyData, partnerData);
    url = appendPartnersFirstParty(url, configParams);
    url += (partnerData.cttl) ? '&cttl=' + encodeURIComponent(partnerData.cttl) : '';
    url += (partnerData.rrtt) ? '&rrtt=' + encodeURIComponent(partnerData.rrtt) : '';
    url = appendCMPData(url, cmpData);
    url += '&japs=' + encodeURIComponent(configParams.siloEnabled === true);
    url = appendCounters(url);
    url += clientHints ? '&uh=' + encodeURIComponent(clientHints) : '';
    url += VERSION ? '&jsver=' + VERSION : '';
    url += firstPartyData?.group ? '&testGroup=' + encodeURIComponent(firstPartyData.group) : '';
    url = addMetaData(url, sourceMetaDataExternal || sourceMetaData);
    url = handleAdditionalParams(currentBrowserLowerCase, url, 1, additionalParams);
    url = appendSPData(url, firstPartyData)
    url += '&source=' + PREBID;

    // Add vrref and fui to the URL
    url = appendVrrefAndFui(url, configParams.domainName);

    const storeFirstPartyData = () => {
      partnerData.eidl = runtimeEids?.eids?.length || -1
      storeData(FIRST_PARTY_KEY_FINAL, JSON.stringify(firstPartyData), allowedStorage, firstPartyData);
      storeData(PARTNER_DATA_KEY, JSON.stringify(partnerData), allowedStorage, firstPartyData);
    }

    const resp = function (callback) {
      const callbacks = {
        success: response => {
          const respJson = tryParse(response);
          // If response is a valid json and should save is true
          if (respJson) {
            partnerData.date = Date.now();
            firstPartyData.sCal = Date.now();
            const defineEmptyDataAndFireCallback = () => {
              respJson.data = partnerData.data = runtimeEids = { eids: [] };
              storeFirstPartyData()
              firePartnerCallback()
              callback(runtimeEids)
            }
            if (callbackTimeoutID) clearTimeout(callbackTimeoutID)
            if ('cttl' in respJson) {
              partnerData.cttl = respJson.cttl;
            } else partnerData.cttl = HOURS_24;

            if ('tc' in respJson) {
              partnerData.terminationCause = respJson.tc;
              if (respJson.tc == 41) {
                firstPartyData.group = WITHOUT_IIQ;
                storeData(FIRST_PARTY_KEY_FINAL, JSON.stringify(firstPartyData), allowedStorage, firstPartyData);
                if (groupChanged) groupChanged(firstPartyData.group);
                defineEmptyDataAndFireCallback();
                if (gamObjectReference) setGamReporting(gamObjectReference, gamParameterName, firstPartyData.group);
                return
              } else {
                firstPartyData.group = WITH_IIQ;
                if (gamObjectReference) setGamReporting(gamObjectReference, gamParameterName, firstPartyData.group);
                if (groupChanged) groupChanged(firstPartyData.group);
              }
            }
            if ('isOptedOut' in respJson) {
              if (respJson.isOptedOut !== firstPartyData.isOptedOut) {
                firstPartyData.isOptedOut = respJson.isOptedOut;
              }
              if (respJson.isOptedOut === true) {
                respJson.data = partnerData.data = runtimeEids = { eids: [] };

                const keysToRemove = [
                  PARTNER_DATA_KEY,
                  CLIENT_HINTS_KEY
                ];

                keysToRemove.forEach(key => removeDataByKey(key, allowedStorage));

                storeData(FIRST_PARTY_KEY_FINAL, JSON.stringify(firstPartyData), allowedStorage, firstPartyData);
                firePartnerCallback();
                callback(runtimeEids);
                return
              }
            }
            if ('pid' in respJson) {
              firstPartyData.pid = respJson.pid;
            }
            if ('dbsaved' in respJson) {
              firstPartyData.dbsaved = respJson.dbsaved;
            }
            if ('ls' in respJson) {
              if (respJson.ls === false) {
                defineEmptyDataAndFireCallback()
                return
              }
              // If data is empty, means we should save as INVALID_ID
              if (respJson.data == '') {
                respJson.data = INVALID_ID;
              } else {
                // If data is a single string, assume it is an id with source intentiq.com
                if (respJson.data && typeof respJson.data === 'string') {
                  respJson.data = {eids: [respJson.data]}
                }
              }
              partnerData.data = respJson.data;
            }

            if ('ct' in respJson) {
              partnerData.clientType = respJson.ct;
            }

            if ('sid' in respJson) {
              partnerData.siteId = respJson.sid;
            }

            if ('spd' in respJson) {
              // server provided data
              firstPartyData.spd = respJson.spd;
            }

            if (rrttStrtTime && rrttStrtTime > 0) {
              partnerData.rrtt = Date.now() - rrttStrtTime;
            }

            if (respJson.data?.eids) {
              runtimeEids = respJson.data
              callback(respJson.data.eids);
              firePartnerCallback()
              const encryptedData = encryptData(JSON.stringify(respJson.data))
              partnerData.data = encryptedData;
            } else {
              callback(runtimeEids);
              firePartnerCallback()
            }
            updateCountersAndStore(runtimeEids, allowedStorage, partnerData);
            storeFirstPartyData();
          } else {
            callback(runtimeEids);
            firePartnerCallback()
          }
        },
        error: error => {
          logError(MODULE_NAME + ': ID fetch encountered an error', error);
          failCount++;
          updateCountersAndStore(runtimeEids, allowedStorage, partnerData);
          callback(runtimeEids);
        }
      };
      rrttStrtTime = Date.now();

      partnerData.wsrvcll = true;
      storeData(PARTNER_DATA_KEY, JSON.stringify(partnerData), allowedStorage, firstPartyData);
      clearCountersAndStore(allowedStorage, partnerData);

      ajax(url, callbacks, undefined, {method: 'GET', withCredentials: true});
    };
    const respObj = {callback: resp};

    if (runtimeEids?.eids?.length) respObj.id = runtimeEids.eids;
    return respObj
  },
  eids: {
    'intentIqId': {
      source: 'intentiq.com',
      atype: 1,
      getSource: function (data) {
        return data.source;
      },
      getValue: function (data) {
        if (data?.uids?.length) {
          return data.uids[0].id
        }
        return null
      },
      getUidExt: function (data) {
        if (data?.uids?.length) {
          return data.uids[0].ext;
        }
        return null
      }
    },
  }
};

submodule('userId', intentIqIdSubmodule);

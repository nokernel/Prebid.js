import { config } from '../src/config.js';
import { submodule } from '../src/hook.js';
import { deepAccess, mergeDeep, prefixLog } from '../src/utils.js';

const MODULE_NAME = 'optable';
export const LOG_PREFIX = `[${MODULE_NAME} RTD]:`;
const optableLog = prefixLog(LOG_PREFIX);
const { logMessage, logWarn, logError } = optableLog;

/**
 * Extracts the parameters for Optable RTD module from the config object passed at instantiation
 * @param {Object} moduleConfig Configuration object for the module
 */
export const parseConfig = (moduleConfig) => {
  let adserverTargeting = deepAccess(moduleConfig, 'params.adserverTargeting', true);
  let handleRtd = deepAccess(moduleConfig, 'params.handleRtd', null);

  if (handleRtd && typeof handleRtd !== 'function') {
    throw new Error(LOG_PREFIX + ' handleRtd must be a function');
  }

  return { adserverTargeting, handleRtd };
}

/**
 * Default function to handle/enrich RTD data
 * @param reqBidsConfigObj Bid request configuration object
 * @param optableExtraData Additional data to be used by the Optable SDK
 * @param mergeFn Function to merge data
 * @returns {Promise<void>}
 */
export const defaultHandleRtd = async (reqBidsConfigObj, optableExtraData, mergeFn) => {
  const optableBundle = /** @type {Object} */ (window.optable);
  // Get targeting data from the cache
  let targetingData = optableBundle?.rtd?.targetingFromCache();
  logMessage('Original targeting data from targetingFromCache(): ', targetingData);

  if (!targetingData || !targetingData.ortb2) {
    logWarn('No targeting data found');
    return;
  }

  mergeFn(
    reqBidsConfigObj.ortb2Fragments.global,
    targetingData.ortb2,
  );
  logMessage('Prebid\'s global ORTB2 object after merge: ', reqBidsConfigObj.ortb2Fragments.global);
};

/**
 * @param {Object} reqBidsConfigObj Bid request configuration object
 * @param {Function} callback Called on completion
 * @param {Object} moduleConfig Configuration for Optable RTD module
 * @param {Object} userConsent
 */
export const getBidRequestData = (reqBidsConfigObj, callback, moduleConfig, userConsent) => {
  try {
    // Extract custom handleRtd function from the module configuration
    const { handleRtd } = parseConfig(moduleConfig);

    // If no custom handleRtd function is provided, use the one from the Optable SDK or the default one
    const handleRtdFn = handleRtd || window.optable?.rtd?.handleRtd || defaultHandleRtd;
    const optableExtraData = config.getConfig('optableRtdConfig') || {};

    // We assume that the Optable JS bundle is already present on the page.
    // If it is, we can directly merge the data by calling the handleRtd function.
    window.optable = window.optable || { cmd: [] };
    window.optable.cmd.push(() => {
      logMessage('Optable JS bundle found on the page');
      try {
        Promise.resolve(handleRtdFn(reqBidsConfigObj, optableExtraData, mergeDeep)).then(callback, callback);
      } catch (error) {
        logError('Error in handleRtd function: ', error);
        callback();
      }
    });
  } catch (error) {
    // If an error occurs, log it and call the callback
    // to continue with the auction
    logError(error);
    callback();
  }
}

/**
 * Get Optable targeting data and merge it into the ad units
 * @param adUnits Array of ad units
 * @param moduleConfig Module configuration
 * @param userConsent User consent
 * @param auction Auction object
 * @returns {Object} Targeting data
 */
export const getTargetingData = (adUnits, moduleConfig, userConsent, auction) => {
  // Extract `adserverTargeting` from the module configuration
  const { adserverTargeting } = parseConfig(moduleConfig);
  logMessage('Ad Server targeting: ', adserverTargeting);

  if (!adserverTargeting) {
    logMessage('Ad server targeting is disabled');
    return {};
  }

  const targetingData = {};

  // Get the Optable targeting data from the cache
  const optableTargetingData = window?.optable?.rtd?.targetingKeyValuesFromCache() || {};

  // If no Optable targeting data is found, return an empty object
  if (!Object.keys(optableTargetingData).length) {
    logWarn('No Optable targeting data found');
    return targetingData;
  }

  // Merge the Optable targeting data into the ad units
  adUnits.forEach(adUnit => {
    targetingData[adUnit] = targetingData[adUnit] || {};
    mergeDeep(targetingData[adUnit], optableTargetingData);
  });

  // If the key contains no data, remove it
  Object.keys(targetingData).forEach((adUnit) => {
    Object.keys(targetingData[adUnit]).forEach((key) => {
      if (!targetingData[adUnit][key] || !targetingData[adUnit][key].length) {
        delete targetingData[adUnit][key];
      }
    });

    // If the ad unit contains no data, remove it
    if (!Object.keys(targetingData[adUnit]).length) {
      delete targetingData[adUnit];
    }
  });

  logMessage('Optable targeting data: ', targetingData);
  return targetingData;
};

/**
 * Dummy init function
 * @param {Object} config Module configuration
 * @param {boolean} userConsent User consent
 * @returns true
 */
const init = (config, userConsent) => {
  return true;
}

// Optable RTD submodule
export const optableSubmodule = {
  name: MODULE_NAME,
  init,
  getBidRequestData,
  getTargetingData,
}

// Register the Optable RTD submodule
submodule('realTimeData', optableSubmodule);

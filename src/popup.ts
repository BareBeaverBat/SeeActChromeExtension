import {createLogger, format} from "winston";
import {BrowserBackgroundTransport} from "./utils/shared_logging_setup";

const logger = createLogger({
    transports: [new BrowserBackgroundTransport({})],
    defaultMeta: {service: 'main-popup'},
    format: format.combine(format.timestamp(), format.json())
});

const startButton = document.getElementById('startAgent');
if (!startButton) throw new Error('startAgent button not found');


/**
 * @description Get the id of the active tab in the current window
 * @returns {Promise<number|undefined>} The id of the active tab, or undefined if the active tab is a chrome:// URL
 *                                          (which scripts can't be injected into for safety reasons)
 * @throws {Error} If the active tab is not found or doesn't have an id
 */
export const getActiveTabId = async (): Promise<number | undefined> => {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    const tab: chrome.tabs.Tab | undefined = tabs[0];
    if (!tab) throw new Error('Active tab not found');
    let id = tab.id;
    if (!id) throw new Error('Active tab id not found');
    if (tab.url && tab.url.startsWith('chrome://')) {
        logger.warn('Active tab is a chrome:// URL: ' + tab.url);
        id = undefined;
    }
    return id;
}
//todo unit test above helper? how hard is it to mock chrome api calls?
// worst case, could make ChromeHelper in utils/ with thing like DomHelper for chrome api's, then unit test ChromeHelper
// with an injected mock of the chrome api helper object

startButton.addEventListener('click', async () => {
    logger.debug('startAgent button clicked');
    const tabId = await getActiveTabId();
    if (!tabId) {
        logger.warn("Can't inject agent script into chrome:// URLs for security reasons; " +
            "please only try to start the agent on a regular web page.");
        return;
    }
    const result = await chrome.scripting.executeScript({
        files: ['./src/page_interaction.js'],
        target: {
            tabId: tabId
        }
    });
    logger.debug('agent script injected into page: ' + result);
});
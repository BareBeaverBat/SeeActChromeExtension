import {ChromeWrapper} from "./ChromeWrapper";
import {createNamedLogger} from "./shared_logging_setup";
import {Logger} from "loglevel";
import {
    Action,
    ActionStateChangeSeverity,
    AgentController2PanelPortMsgType, AnnotationCoordinator2PanelPortMsgType,
    buildGenericActionDesc, defaultIsAnnotatorMode,
    defaultIsMonitorMode,
    defaultShouldWipeActionHistoryOnStart,
    expectedMsgForPortDisconnection,
    Panel2AgentControllerPortMsgType, panelToAnnotationCoordinatorPort, PanelToAnnotationCoordinatorPortMsgType,
    panelToControllerPort,
    renderUnknownValue,
    setupModeCache, storageKeyForAnnotatorMode,
    storageKeyForEulaAcceptance,
    storageKeyForMonitorMode,
    storageKeyForShouldWipeHistoryOnTaskStart
} from "./misc";
import {Mutex} from "async-mutex";
import {ActionInfo} from "./AgentController";
import saveAs from "file-saver";
import {marked} from "marked";


export interface SidePanelElements {
    eulaComplaintContainer: HTMLDivElement,
    annotatorContainer: HTMLDivElement,
    annotatorActionType: HTMLSelectElement,
    annotatorActionStateChangeSeverity: HTMLSelectElement,
    annotatorExplanationField: HTMLTextAreaElement,
    annotatorStatusDiv: HTMLDivElement,
    startButton: HTMLButtonElement;
    taskSpecField: HTMLTextAreaElement;
    agentStatusDiv: HTMLDivElement;
    statusPopup: HTMLSpanElement;
    killButton: HTMLButtonElement;
    historyList: HTMLOListElement;
    pendingActionDiv: HTMLDivElement;
    monitorModeContainer: HTMLDivElement;
    monitorFeedbackField: HTMLTextAreaElement;
    monitorApproveButton: HTMLButtonElement;
    monitorRejectButton: HTMLButtonElement;
    unaffiliatedLogsExportButton: HTMLButtonElement;
}

/**
 * states for the Side Panel Manager Finite State Machine
 */
enum SidePanelMgrState {
    IDLE,
    WAIT_FOR_CONNECTION_INIT,
    WAIT_FOR_TASK_STARTED,
    WAIT_FOR_PENDING_ACTION_INFO,
    WAIT_FOR_MONITOR_RESPONSE,//unlike the others, in this state the panel is primarily waiting for input from the user to the side panel's UI rather than from the background (service worker)
    WAIT_FOR_ACTION_PERFORMED_RECORD,
    WAIT_FOR_TASK_ENDED//panel only reaches this state for a task that the user decides to kill, not for a task that ends naturally
}

export class SidePanelManager {
    private readonly eulaComplaintContainer: HTMLDivElement;

    private readonly annotatorContainer: HTMLDivElement;
    private readonly annotatorActionType: HTMLSelectElement;
    private readonly annotatorActionStateChangeSeverity: HTMLSelectElement;
    private readonly annotatorExplanationField: HTMLTextAreaElement;
    private readonly annotatorStatusDiv: HTMLDivElement;

    private readonly startButton: HTMLButtonElement;
    private readonly taskSpecField: HTMLTextAreaElement;
    private readonly agentStatusDiv: HTMLDivElement;
    private readonly statusPopup: HTMLSpanElement;
    private readonly killButton: HTMLButtonElement;
    private readonly historyList: HTMLOListElement;
    private readonly pendingActionDiv: HTMLDivElement;
    private readonly monitorModeContainer: HTMLDivElement;
    private readonly monitorFeedbackField: HTMLTextAreaElement;
    private readonly monitorApproveButton: HTMLButtonElement;
    private readonly monitorRejectButton: HTMLButtonElement;
    private readonly unaffiliatedLogsExportButton: HTMLButtonElement;

    private readonly chromeWrapper: ChromeWrapper;
    readonly logger: Logger;
    private readonly dom: Document;

    readonly mutex = new Mutex();

    //allow read access to this without mutex; only written to by the handleMonitorModeCacheUpdate method
    //has to initially be true (even if the default is actually false) so that handleMonitorModeCacheUpdate() call
    // in constructor will minimize the monitor mode UI
    cachedMonitorMode = true;
    shouldWipeActionHistoryOnTaskStart = defaultShouldWipeActionHistoryOnStart;
    //because this is above other ui elements, we don't need complex resizing logic for when it becomes enabled/visible vs disabled/hidden
    cachedIsAnnotatorMode = defaultIsAnnotatorMode;

    isMonitorModeTempEnabled = false;

    private state: SidePanelMgrState = SidePanelMgrState.IDLE;
    public agentControllerPort?: chrome.runtime.Port;
    public agentControllerReady = false;
    public annotationCoordinatorPort?: chrome.runtime.Port;
    lastHeightOfMonitorModeContainer = 0;//px

    public mouseClientX = -1;
    public mouseClientY = -1;

    constructor(elements: SidePanelElements, chromeWrapper?: ChromeWrapper, logger?: Logger, overrideDoc?: Document) {
        this.eulaComplaintContainer = elements.eulaComplaintContainer;
        this.annotatorContainer = elements.annotatorContainer;
        this.annotatorActionType = elements.annotatorActionType;
        this.annotatorActionStateChangeSeverity = elements.annotatorActionStateChangeSeverity;
        this.annotatorExplanationField = elements.annotatorExplanationField;
        this.annotatorStatusDiv = elements.annotatorStatusDiv;
        this.startButton = elements.startButton;
        this.taskSpecField = elements.taskSpecField;
        this.agentStatusDiv = elements.agentStatusDiv;
        this.statusPopup = elements.statusPopup;
        this.killButton = elements.killButton;
        this.historyList = elements.historyList;
        this.pendingActionDiv = elements.pendingActionDiv;
        this.monitorModeContainer = elements.monitorModeContainer;
        this.monitorFeedbackField = elements.monitorFeedbackField;
        this.monitorApproveButton = elements.monitorApproveButton;
        this.monitorRejectButton = elements.monitorRejectButton;
        this.unaffiliatedLogsExportButton = elements.unaffiliatedLogsExportButton;

        this.chromeWrapper = chromeWrapper ?? new ChromeWrapper();
        this.logger = logger ?? createNamedLogger('side-panel-mgr', false);
        this.dom = overrideDoc ?? document;

        //have to initialize to default value this way to ensure that the monitor mode container is hidden if the default is false
        this.handleMonitorModeCacheUpdate(defaultIsMonitorMode);

        setupModeCache(this.handleMonitorModeCacheUpdate, "monitor mode", storageKeyForMonitorMode, this.logger);
        setupModeCache(this.handleAnnotatorModeCacheUpdate, "annotator mode", storageKeyForAnnotatorMode, this.logger);
        if (chrome?.storage?.local) {
            chrome.storage.local.get([storageKeyForShouldWipeHistoryOnTaskStart, storageKeyForEulaAcceptance], (items) => {
                this.validateAndApplySidePanelOptions(true, items[storageKeyForShouldWipeHistoryOnTaskStart], items[storageKeyForEulaAcceptance]);
            });
            chrome.storage.local.onChanged.addListener((changes: { [p: string]: chrome.storage.StorageChange }) => {
                this.validateAndApplySidePanelOptions(false, changes[storageKeyForShouldWipeHistoryOnTaskStart]?.newValue,
                    changes[storageKeyForEulaAcceptance]?.newValue);
            });
        }

        try {
            this.establishServiceWorkerConnection();
        } catch (error: any) {
            this.logger.error('error while establishing service worker connection:', renderUnknownValue(error));
            try {
                this.establishServiceWorkerConnection();
            } catch (error: any) {
                this.logger.error('error while retrying to establish service worker connection:', renderUnknownValue(error));
                this.setAgentStatusWithDelayedClear('Persistent errors while trying to establish connection to agent controller; Please close and reopen the side panel to try again');
            }
        }
    }

    /**
     * @description validates and applies the side panel options that are stored in local storage
     * @param initOrUpdate whether the context for the call is the initial loading of options from storage or a later update
     * @param newShouldWipeHistoryOnTaskStartVal the new value for shouldWipeHistoryOnTaskStart, if it is a valid boolean
     * @param isEulaAccepted whether the EULA has been accepted, if it is a valid boolean
     */
    validateAndApplySidePanelOptions = (initOrUpdate: boolean, newShouldWipeHistoryOnTaskStartVal: unknown,
                                        isEulaAccepted: unknown): void => {
        const contextStr = initOrUpdate ? "when loading options from storage" : "when processing an update from storage";
        if (typeof newShouldWipeHistoryOnTaskStartVal === "boolean") {
            this.shouldWipeActionHistoryOnTaskStart = newShouldWipeHistoryOnTaskStartVal;
        } else if (typeof newShouldWipeHistoryOnTaskStartVal !== "undefined") {this.logger.error(`invalid shouldWipeHistoryOnTaskStart value ${newShouldWipeHistoryOnTaskStartVal} detected in local storage ${contextStr}, ignoring it`)}

        if (typeof isEulaAccepted === "undefined") {
            this.logger.debug(`EULA acceptance value not found in local storage ${contextStr}, ignoring`);
        } else if (typeof isEulaAccepted !== "boolean") {
            this.logger.error(`invalid EULA acceptance value ${renderUnknownValue(isEulaAccepted)} detected in local storage ${contextStr}, ignoring`);
        } else if (isEulaAccepted) {
            this.logger.debug("EULA acceptance detected in local storage, hiding EULA complaint and re-enabling relevant interactive parts of UI");
            this.eulaComplaintContainer.hidden = true;
            this.startButton.disabled = false;
            this.taskSpecField.disabled = false;
            this.unaffiliatedLogsExportButton.disabled = false;
        } else {
            this.logger.debug("EULA acceptance not detected in local storage, showing EULA complaint and disabling relevant interactive parts of UI");
            this.eulaComplaintContainer.hidden = false;
            this.startButton.disabled = true;
            this.taskSpecField.disabled = true;
            this.unaffiliatedLogsExportButton.disabled = true;
        }
    }

    establishServiceWorkerConnection = (): void => {
        this.agentControllerReady = false;

        this.state = SidePanelMgrState.WAIT_FOR_CONNECTION_INIT;
        this.agentControllerPort = chrome.runtime.connect({name: panelToControllerPort});
        this.agentControllerPort.onMessage.addListener(this.handleAgentControllerMsg);
        this.agentControllerPort.onDisconnect.addListener(this.handleAgentControllerDisconnect);
    }

    pingServiceWorkerForKeepAlive = async (swPort: chrome.runtime.Port): Promise<void> => {
        try {
            swPort.postMessage({type: Panel2AgentControllerPortMsgType.KEEP_ALIVE});
        } catch (error: any) {
            if ('message' in error && error.message === expectedMsgForPortDisconnection) {
                this.logger.info('chain of keep-alive pings to service worker terminating because service worker disconnected');
            } else {
                this.logger.error('chain of keep-alive pings to service worker terminating because of unexpected error:', renderUnknownValue(error));
            }
            return;
        }
        const nearly_service_worker_timeout = 28000;
        setTimeout(() => this.pingServiceWorkerForKeepAlive(swPort), nearly_service_worker_timeout);
    }


    startTaskClickHandler = async (): Promise<void> => {
        this.logger.trace('startAgent button clicked');
        await this.mutex.runExclusive(async () => {
            this.logger.trace("start task button click being handled")
            if (this.taskSpecField.value.trim() === '') {
                const taskEmptyWhenStartMsg = "task specification field is empty (or all whitespace), can't start agent";
                this.logger.warn(taskEmptyWhenStartMsg);
                this.setAgentStatusWithDelayedClear(taskEmptyWhenStartMsg, 3);
            } else if (this.state !== SidePanelMgrState.IDLE) {
                const existingTaskMsg = 'another task is already running, cannot start task';
                this.logger.warn(existingTaskMsg);
                this.setAgentStatusWithDelayedClear(existingTaskMsg, 3);
            } else if (!this.agentControllerPort) {
                this.logger.error('service worker port is broken or missing, cannot start task');
                this.setAgentStatusWithDelayedClear('Connection to agent controller is missing, so cannot start task (starting it up again); please try again after status display shows that connection is working again', 3);

                try {
                    this.establishServiceWorkerConnection();
                } catch (error: any) {
                    this.setAgentStatusWithDelayedClear('Error while trying to establish connection to agent controller; Please close and reopen the side panel to try again');
                    this.logger.error('error while establishing service worker connection after start task button clicked', renderUnknownValue(error));
                }
            } else if (!this.agentControllerReady) {
                this.logger.info("start task button clicked when port to service worker exists but service worker has not yet confirmed its readiness; ignoring");
                this.setAgentStatusWithDelayedClear("Agent controller not ready yet, please wait a moment and try again");
            } else {
                const taskSpec = this.taskSpecField.value;
                if (taskSpec.trim() === '') {
                    const cantStartErrMsg = 'task specification field became empty (or all whitespace) since Start Task button was clicked, cannot start task';
                    this.logger.error(cantStartErrMsg);
                    this.setAgentStatusWithDelayedClear(cantStartErrMsg);
                    this.state = SidePanelMgrState.IDLE;
                } else {
                    try {
                        this.agentControllerPort.postMessage(
                            {type: Panel2AgentControllerPortMsgType.START_TASK, taskSpecification: taskSpec});
                    } catch (error: any) {
                        this.logger.error(`error while sending task start command to service worker: ${error.message}`);
                        this.reset();
                        return;
                    }
                    this.state = SidePanelMgrState.WAIT_FOR_TASK_STARTED;
                    this.logger.trace("sent START_TASK message to service worker port");
                    if (this.shouldWipeActionHistoryOnTaskStart) {
                        while (this.historyList.firstChild) { this.historyList.removeChild(this.historyList.firstChild);}
                    }
                }
            }
        });
    }

    killTaskClickHandler = async (): Promise<void> => {
        this.logger.trace('endTask button clicked');
        await this.mutex.runExclusive(async () => {
            this.logger.trace("end task button click being handled")
            if (this.state === SidePanelMgrState.IDLE || this.state === SidePanelMgrState.WAIT_FOR_TASK_ENDED) {
                const noTaskToKillMsg = 'task is not in progress, cannot kill task';
                this.logger.warn(noTaskToKillMsg);
                this.setAgentStatusWithDelayedClear(noTaskToKillMsg, 3);
                return;
            } else if (!this.agentControllerPort) {
                const missingConnectionMsg = 'connection to agent controller does not exist, cannot kill task';
                this.logger.warn(missingConnectionMsg);
                this.setAgentStatusWithDelayedClear(missingConnectionMsg, 3);
                return;
            }
            try {
                this.agentControllerPort.postMessage({type: Panel2AgentControllerPortMsgType.KILL_TASK});
            } catch (error: any) {
                this.logger.error(`error while sending task termination command to service worker: ${error.message}`);
                this.reset();
                return;
            }
            this.state = SidePanelMgrState.WAIT_FOR_TASK_ENDED;
        });
    }

    optionsButtonClickHandler = (): void => {
        this.logger.trace('options button clicked');

        if (chrome.runtime.openOptionsPage) {
            chrome.runtime.openOptionsPage().then(() => {
                this.logger.trace('options page opened');
            }, (err) => {
                this.logger.error('error while opening options page:', err);
            });
        } else {
            this.logger.trace('chrome.runtime.openOptionsPage() not available, opening options.html directly');
            window.open(chrome.runtime.getURL('src/options.html'));
        }
    }

    unaffiliatedLogsExportButtonClickHandler = async (): Promise<void> => {
        this.logger.trace('export unaffiliated logs button clicked');
        await this.mutex.runExclusive(async () => {
            if (!this.agentControllerPort) {
                this.logger.error('service worker port is broken or missing, cannot export non-task-specific logs');
                this.setAgentStatusWithDelayedClear('Connection to agent controller is missing, so cannot export non-task-specific logs (reopening the connection in background); please try again after status display shows that connection is working again', 3);

                try {
                    this.establishServiceWorkerConnection();
                } catch (error: any) {
                    this.setAgentStatusWithDelayedClear('Error while trying to establish connection to agent controller; Please close and reopen the side panel to try again');
                    this.logger.error('error while establishing service worker connection after unaffiliated logs export button clicked', renderUnknownValue(error));
                }
            } else if (!this.agentControllerReady) {
                this.logger.info("unaffiliated logs export button clicked when port to service worker exists but service worker has not yet confirmed its readiness; ignoring");
                this.setAgentStatusWithDelayedClear("Agent controller not ready yet, please wait a moment and try again");
            } else {
                try {
                    this.agentControllerPort.postMessage({type: Panel2AgentControllerPortMsgType.EXPORT_UNAFFILIATED_LOGS});
                } catch (error: any) {
                    this.logger.error(`error while sending "export non-task-specific logs" command to service worker: ${error.message}`);
                    this.reset();
                    return;
                }
            }
        });
    }

    monitorApproveButtonClickHandler = async (): Promise<void> => {
        if (!this.cachedMonitorMode) {
            this.logger.error("monitor mode not enabled, approve button shouldn't be clickable; ignoring");
            return;
        }
        await this.mutex.runExclusive(() => {
            if (this.state !== SidePanelMgrState.WAIT_FOR_MONITOR_RESPONSE) {
                this.logger.error("approve button clicked but state is not WAIT_FOR_MONITOR_RESPONSE; ignoring");
                return;
            } else if (!this.agentControllerPort) {
                this.logger.error("service worker port doesn't exist, can't approve the pending action");
                return;
            }
            try {
                this.agentControllerPort.postMessage({type: Panel2AgentControllerPortMsgType.MONITOR_APPROVED});
            } catch (error: any) {
                this.logger.error(`error while sending monitor approval message to service worker: ${error.message}`);
                this.reset();
                return;
            }
            this.state = SidePanelMgrState.WAIT_FOR_ACTION_PERFORMED_RECORD;
            this.pendingActionDiv.textContent = '';
            this.pendingActionDiv.title = '';
            this.testAndCleanUpTempMonitorMode();
        });
    }

    private testAndCleanUpTempMonitorMode() {
        if (this.isMonitorModeTempEnabled) {
            this.isMonitorModeTempEnabled = false;
            this.monitorApproveButton.disabled = true;
            this.monitorRejectButton.disabled = true;
            this.monitorFeedbackField.disabled = true;
            this.handleMonitorModeCacheUpdate(false);
        }
    }

    monitorRejectButtonClickHandler = async (): Promise<void> => {
        if (!this.cachedMonitorMode) {
            this.logger.error("monitor mode not enabled, reject button shouldn't be clickable; ignoring");
            return;
        }
        await this.mutex.runExclusive(() => {
            if (this.state !== SidePanelMgrState.WAIT_FOR_MONITOR_RESPONSE) {
                this.logger.error("reject button clicked but state is not WAIT_FOR_MONITOR_RESPONSE; ignoring");
                return;
            } else if (!this.agentControllerPort) {
                this.logger.error("service worker port doesn't exist, can't reject the pending action");
                return;
            }
            const feedbackText = this.monitorFeedbackField.value;
            try {
                this.agentControllerPort.postMessage(
                    {type: Panel2AgentControllerPortMsgType.MONITOR_REJECTED, feedback: feedbackText});
            } catch (error: any) {
                this.logger.error(`error while sending monitor rejection message to service worker: ${error.message}`);
                this.reset();
                return;
            }
            this.state = SidePanelMgrState.WAIT_FOR_PENDING_ACTION_INFO;
            this.pendingActionDiv.textContent = '';
            this.pendingActionDiv.title = '';
            this.monitorFeedbackField.value = '';
            this.testAndCleanUpTempMonitorMode();
        });
    }

    handleAgentControllerMsg = async (message: any): Promise<void> => {
        this.logger.trace(`message received from agent controller by side panel: ${JSON.stringify(message)
            .slice(0, 100)}...`);
        if (message.type === AgentController2PanelPortMsgType.AGENT_CONTROLLER_READY) {
            await this.mutex.runExclusive(() => this.processConnectionReady());
        } else if (message.type === AgentController2PanelPortMsgType.TASK_STARTED) {
            await this.mutex.runExclusive(() => this.processTaskStartConfirmation(message));
        } else if (message.type === AgentController2PanelPortMsgType.ACTION_CANDIDATE) {
            await this.mutex.runExclusive(() => this.processActionCandidate(message));
        } else if (message.type === AgentController2PanelPortMsgType.AUTO_MONITOR_ESCALATION) {
            await this.mutex.runExclusive(() => this.processAutoMonitorEscalation(message));
        } else if (message.type === AgentController2PanelPortMsgType.TASK_HISTORY_ENTRY) {
            await this.mutex.runExclusive(() => this.processActionPerformedRecord(message));
        } else if (message.type === AgentController2PanelPortMsgType.TASK_ENDED) {
            await this.mutex.runExclusive(() => this.processTaskEndConfirmation(message));
        } else if (message.type === AgentController2PanelPortMsgType.ERROR) {
            await this.mutex.runExclusive(() => this.processErrorFromController(message));
        } else if (message.type === AgentController2PanelPortMsgType.HISTORY_EXPORT) {
            this.processFileDownload(message);
        } else if (message.type === AgentController2PanelPortMsgType.NOTIFICATION) {
            this.setAgentStatusWithDelayedClear(message.msg, 30, message.details);//give user plenty of time to read details
        } else {
            this.logger.warn(`unknown type of message from agent controller: ${JSON.stringify(message)}`);
        }
    }

    private processFileDownload(message: any) {
        try {
            this.logger.debug(`received array of data from background script for a zip file, length: ${message.data.length}`);
            const arrBuff = new Uint8Array(message.data).buffer;
            this.logger.debug(`converted array of data to array buffer, length: ${arrBuff.byteLength}`);
            const blob = new Blob([arrBuff]);
            this.logger.debug(`after converting array buffer to blob, length is ${blob.size} bytes`);
            this.logger.debug(`about to save zip file ${message.fileName} to user's computer`);
            saveAs(blob, message.fileName);
            this.logger.info(`successfully saved zip file ${message.fileName}`);
        } catch (error: any) {
            const errMsg = `error while trying to save zip file to user's computer: ${error.message}`;
            this.logger.error(errMsg);
            this.setAgentStatusWithDelayedClear(errMsg);
        }
    }

    private processErrorFromController(message: any) {
        this.logger.error(`error message from background script: ${message.msg}`);
        this.setAgentStatusWithDelayedClear(`Error: ${message.msg}`, 5);
        this.reset();
    }

    private reset() {
        this.state = SidePanelMgrState.IDLE;
        this.taskSpecField.value = '';
        this.startButton.disabled = false;
        this.killButton.disabled = true;
        this.pendingActionDiv.textContent = '';
        this.pendingActionDiv.title = '';
        this.monitorFeedbackField.value = '';
        this.monitorFeedbackField.disabled = true;
        this.monitorApproveButton.disabled = true;
        this.monitorRejectButton.disabled = true;

        if (this.isMonitorModeTempEnabled) {
            this.handleMonitorModeCacheUpdate(false);
            this.isMonitorModeTempEnabled = false;
        }

        if (this.cachedIsAnnotatorMode) {
            this.annotatorActionType.value = Action.CLICK;
            this.annotatorActionStateChangeSeverity.value = ActionStateChangeSeverity.SAFE;
            this.annotatorExplanationField.value = '';
        }
    }

    processConnectionReady = (): void => {
        if (this.state !== SidePanelMgrState.WAIT_FOR_CONNECTION_INIT) {
            this.logger.error('received READY message from service worker port but state is not WAIT_FOR_CONNECTION_INIT');
            return;
        } else if (!this.agentControllerPort) {
            this.logger.error('received READY message from service worker port but serviceWorkerPort is undefined');
            return;
        } else if (this.agentControllerReady) {
            this.logger.warn("received notification of readiness from agent controller when side panel already thought agent controller was active and ready")
        }
        this.logger.trace("agent controller notified side panel of its readiness");
        this.agentControllerReady = true;
        this.setAgentStatusWithDelayedClear('Agent controller connection ready; you can now start a task, export non-task-specific logs, etc.');

        this.pingServiceWorkerForKeepAlive(this.agentControllerPort).catch((error) => {
            this.logger.error('error while starting keepalive pings to service worker:', renderUnknownValue(error));
        });

        this.state = SidePanelMgrState.IDLE;
    }

    processTaskStartConfirmation = (message: any): void => {
        if (this.state !== SidePanelMgrState.WAIT_FOR_TASK_STARTED) {
            this.logger.error('received TASK_STARTED message from service worker port but state is not WAIT_FOR_TASK_STARTED');
            return;
        }
        let newStatus = '';
        if (message.success) {
            this.logger.trace("received notification of successful task start from agent controller");
            newStatus = `Task ${message.taskId} started successfully`;
            this.state = SidePanelMgrState.WAIT_FOR_PENDING_ACTION_INFO;

            this.addHistoryEntry(`Task started: ${message.taskSpec}`, `Task ID: ${message.taskId}`, "task_start")
            this.startButton.disabled = true;
            this.killButton.disabled = false;
            this.taskSpecField.value = '';
            if (this.cachedMonitorMode) {
                this.monitorFeedbackField.disabled = false;
            }
        } else {
            newStatus = 'Task start failed: ' + message.message;
            this.state = SidePanelMgrState.IDLE;
        }
        this.setAgentStatusWithDelayedClear(newStatus);
    }

    processActionCandidate = (message: any): void => {
        if (this.state === SidePanelMgrState.WAIT_FOR_MONITOR_RESPONSE) {
            this.logger.trace("received ACTION_CANDIDATE message from service worker port while waiting for monitor response from user; implies that a keyboard shortcut for a monitor rejection was used instead of the side panel ui");
            this.testAndCleanUpTempMonitorMode();
        } else if (this.state != SidePanelMgrState.WAIT_FOR_PENDING_ACTION_INFO) {
            this.logger.error('received ACTION_CANDIDATE message from service worker port but state is not WAIT_FOR_PENDING_ACTION_INFO');
            return;
        }

        if (this.cachedMonitorMode) {
            this.monitorApproveButton.disabled = false;
            this.monitorRejectButton.disabled = false;

            this.state = SidePanelMgrState.WAIT_FOR_MONITOR_RESPONSE;
        } else {
            this.state = SidePanelMgrState.WAIT_FOR_ACTION_PERFORMED_RECORD;
        }

        const pendingActionInfo = message.actionInfo as ActionInfo;
        this.pendingActionDiv.textContent = pendingActionInfo.explanation;
        this.pendingActionDiv.title = buildGenericActionDesc(pendingActionInfo.action, pendingActionInfo.elementData, pendingActionInfo.value)
    }

    processAutoMonitorEscalation = (message: any): void => {
        this.isMonitorModeTempEnabled = true;
        this.handleMonitorModeCacheUpdate(true);
        //todo revert this when judge goes back to normal (i.e. judge not blocking/escalating actions that fall below current threshold)
        this.setAgentStatusWithDelayedClear(`Pending action judged at danger level ${message.severity} (hover for reason); please review then approve or reject`, 15, `Explanation of judgement: ${message.explanation}`);
        this.monitorApproveButton.disabled = false;
        this.monitorRejectButton.disabled = false;
        this.monitorFeedbackField.disabled = false;

        this.state = SidePanelMgrState.WAIT_FOR_MONITOR_RESPONSE;
    }

    processActionPerformedRecord = (message: any): void => {
        if (this.state === SidePanelMgrState.WAIT_FOR_MONITOR_RESPONSE) {
            this.logger.debug("received TASK_HISTORY_ENTRY message from service worker port while waiting for monitor response from user; implies that a keyboard shortcut for a monitor judgement was used instead of the side panel ui");
            this.testAndCleanUpTempMonitorMode();
        } else if (this.state !== SidePanelMgrState.WAIT_FOR_ACTION_PERFORMED_RECORD) {
            this.logger.error('received TASK_HISTORY_ENTRY message from service worker port but state is not WAIT_FOR_ACTION_PERFORMED_RECORD');
            return;
        }

        const actionDesc = message.actionDesc as string;
        const successful = message.success as boolean;
        const explanation = message.explanation as string;
        const actionInfo = message.actionInfo as ActionInfo | undefined;

        let displayText = "";
        let hoverText = "";
        const successTxt = successful ? "SUCCEEDED" : "FAILED";
        if (actionInfo) {
            const elementData = actionInfo.elementData;
            if (elementData) {
                const optionalValueMsg = actionInfo.value ? ` with value: ${actionInfo.value}` : '';
                displayText = `${successTxt}: ${actionInfo.action}${optionalValueMsg} on a ${elementData.tagName} element; ${explanation}`;
                hoverText = `Element description: ${elementData.description}; Action full description: ${actionDesc}`;
            } else {
                displayText = `${successTxt}: ${actionDesc}; ${explanation}`;
                hoverText = `Action name ${actionInfo.action}; action value: ${actionInfo.value}`;
            }
        } else {
            displayText = `${successTxt}: ${explanation}`;
            hoverText = `Action: ${actionDesc}`;
        }

        this.addHistoryEntry(displayText, hoverText);
        if (this.cachedMonitorMode) {
            this.monitorFeedbackField.value = '';
            this.monitorApproveButton.disabled = true;
            this.monitorRejectButton.disabled = true;
        }
        this.state = SidePanelMgrState.WAIT_FOR_PENDING_ACTION_INFO;
        this.pendingActionDiv.textContent = '';
        this.pendingActionDiv.title = '';
    }


    processTaskEndConfirmation = (message: any): void => {
        if (this.state === SidePanelMgrState.WAIT_FOR_TASK_STARTED) {
            this.logger.warn("task start failed");
            this.setAgentStatusWithDelayedClear(`Task start failed`, 10, message.details);
        } else {
            if (this.state !== SidePanelMgrState.WAIT_FOR_PENDING_ACTION_INFO
                && this.state !== SidePanelMgrState.WAIT_FOR_TASK_ENDED) {
                this.logger.error(`received TASK_ENDED message from service worker port unexpectedly (while in state ${SidePanelMgrState[this.state]})`);
            }
            this.setAgentStatusWithDelayedClear(`Task ${message.taskId} ended`, 30, message.details);
            this.addHistoryEntry(`Task ended`, `Ended task id: ${message.taskId} for reason ${message.details}`, "task_end");
        }
        this.reset();
    }


    private setAgentStatusWithDelayedClear(status: string, delay: number = 10, hovertext?: string) {
        this.agentStatusDiv.textContent = status;
        if (hovertext) {
            this.statusPopup.innerHTML = marked.setOptions({async: false}).parse(hovertext) as string;
        }
        setTimeout(() => {
            this.logger.trace(`after ${delay} seconds, clearing agent status ${status} with hovertext ${hovertext?.slice(0, 100)}...`);
            this.agentStatusDiv.textContent = 'No status update available at the moment.';
            this.statusPopup.innerHTML = '';
            this.statusPopup.style.display = "none";
        }, delay * 1000)
    }

    private setAnnotatorStatusWithDelayedClear(status: string, delay: number = 10, hovertext?: string) {
        this.annotatorStatusDiv.textContent = status;
        if (hovertext) {
            this.annotatorStatusDiv.title = hovertext;
        }
        setTimeout(() => {
            this.logger.trace(`after ${delay} seconds, clearing annotator status ${status} with hovertext ${hovertext?.slice(0, 100)}...`);
            this.annotatorStatusDiv.textContent = 'No status update available at the moment.';
            this.annotatorStatusDiv.title = '';
        }, delay * 1000)
    }

    handleAgentControllerDisconnect = async (): Promise<void> => {
        this.logger.warn('service worker port disconnected unexpectedly; attempting to reestablish connection');
        this.setAgentStatusWithDelayedClear("Agent controller connection lost. Please wait while it is started up again");
        await this.mutex.runExclusive(() => {
            this.reset();
            try {
                this.establishServiceWorkerConnection();
            } catch (error: any) {this.logger.error('error while reestablishing service worker connection:', renderUnknownValue(error));}
        });
    }

    addHistoryEntry = (displayedText: string, hoverText: string, specialClass?: string): void => {
        const newEntry = this.dom.createElement('li');
        if (specialClass) {
            newEntry.classList.add(specialClass);
        }
        newEntry.textContent = displayedText;
        newEntry.title = hoverText;
        this.historyList.appendChild(newEntry);
        //todo if mouse is not inside history element (i.e. if user isn't looking at an existing history entry),
        // automatically scroll the history element's contents to bottom to show the latest history entry
    }

    displayStatusPopup = (): void => {
        if (this.statusPopup.style.display !== "block" && this.statusPopup.innerHTML.trim() !== "") {
            this.statusPopup.style.display = "block";
            const statusRect = this.agentStatusDiv.getBoundingClientRect();
            this.statusPopup.style.maxHeight = `${statusRect.top}px`;
            this.statusPopup.style.left = `0px`;
            //the addition of 7 is so the details popup overlaps a little with the status div and so you can move
            // the mouse from the div to the popup without the popup sometimes disappearing
            this.statusPopup.style.top = `${statusRect.y + 7 - this.statusPopup.offsetHeight + window.scrollY}px`;
        }
    }

    handleMouseLeaveStatus = (elementThatWasLeft: HTMLElement): void => {
        //using referential equality intentionally here
        const otherStatusElemRect = (elementThatWasLeft == this.agentStatusDiv ? this.statusPopup : this.agentStatusDiv).getBoundingClientRect();
        if (this.mouseClientX < otherStatusElemRect.left || this.mouseClientX > otherStatusElemRect.right
            || this.mouseClientY < otherStatusElemRect.top || this.mouseClientY > otherStatusElemRect.bottom) {
            this.statusPopup.style.display = 'none';
        }
    }

    handleMonitorModeCacheUpdate = (newMonitorModeVal: boolean) => {
        this.mutex.runExclusive(() => {
            const priorCachedMonitorModeVal = this.cachedMonitorMode;
            this.cachedMonitorMode = newMonitorModeVal;
            if (priorCachedMonitorModeVal === newMonitorModeVal) {
                this.logger.trace(`side panel cache of monitor mode received an update which agreed with the existing cached value ${this.cachedMonitorMode}`)
                return;
            }
            const priorHistoryHeight = this.historyList.getBoundingClientRect().height;//px

            if (newMonitorModeVal) {//re-displaying monitor mode UI
                const newHistoryHeight = priorHistoryHeight - this.lastHeightOfMonitorModeContainer;//px
                this.historyList.style.height = `${(newHistoryHeight)}px`;
                this.monitorModeContainer.style.display = "block";
            } else {//collapsing monitor mode UI
                this.lastHeightOfMonitorModeContainer = this.monitorModeContainer.getBoundingClientRect().height;
                const newHistoryHeight = priorHistoryHeight + this.lastHeightOfMonitorModeContainer;//px
                this.historyList.style.height = `${(newHistoryHeight)}px`;
                this.monitorModeContainer.style.display = "none";
            }
        }).catch((error) => this.logger.error(`error while updating monitor mode cache: ${renderUnknownValue(error)}`));
    }

    handleAnnotatorModeCacheUpdate = (newAnnotatorModeVal: boolean) => {
        this.cachedIsAnnotatorMode = newAnnotatorModeVal;
        if (newAnnotatorModeVal) {
            this.annotatorContainer.style.display = "block";
            if (!this.annotationCoordinatorPort) {
                this.annotationCoordinatorPort = chrome.runtime.connect({name: panelToAnnotationCoordinatorPort});
                this.annotationCoordinatorPort.onMessage.addListener(this.handleAnnotationCoordinatorMsg);
                this.annotationCoordinatorPort.onDisconnect.addListener(this.handleAnnotationCoordinatorDisconnect);
            }
        } else {
            this.annotatorContainer.style.display = "none";
        }
    }

    handleAnnotationCoordinatorMsg = async (message: any, port: chrome.runtime.Port): Promise<void> => {
        this.logger.trace(`message received from annotation coordinator by side panel: ${JSON.stringify(message)
            .slice(0, 100)}...`);
        if (message.type === AnnotationCoordinator2PanelPortMsgType.REQ_ANNOTATION_DETAILS) {
            //just reads data from ui and doesn't modify state, no need for mutex
            port.postMessage({
                type: PanelToAnnotationCoordinatorPortMsgType.ANNOTATION_DETAILS,
                actionType: this.annotatorActionType.value, explanation: this.annotatorExplanationField.value,
                actionStateChangeSeverity: this.annotatorActionStateChangeSeverity.value
            })
        } else if (message.type === AnnotationCoordinator2PanelPortMsgType.ANNOTATED_ACTION_EXPORT) {
            this.processFileDownload(message);
            await this.mutex.runExclusive(() => {
                this.reset()
            });
        } else if (message.type === AnnotationCoordinator2PanelPortMsgType.NOTIFICATION) {
            this.setAnnotatorStatusWithDelayedClear(message.msg, 10, message.details);
        } else {
            this.logger.warn(`unknown type of message from annotation coordinator: ${JSON.stringify(message)}`);
        }
    }

    handleAnnotationCoordinatorDisconnect = async (): Promise<void> => {
        this.logger.info("annotation coordinator port disconnected unexpectedly; attempting to reopen");
        await this.mutex.runExclusive(() => {
            this.annotationCoordinatorPort = chrome.runtime.connect({name: panelToAnnotationCoordinatorPort});
            this.annotationCoordinatorPort.onMessage.addListener(this.handleAnnotationCoordinatorMsg);
            this.annotationCoordinatorPort.onDisconnect.addListener(this.handleAnnotationCoordinatorDisconnect);
        });
    }

    startActionAnnotationCapturer = (): void => {
        if (this.annotationCoordinatorPort) {
            this.annotationCoordinatorPort.postMessage({type: PanelToAnnotationCoordinatorPortMsgType.START_CAPTURER});
        } else {
            this.logger.error("annotation coordinator port doesn't exist, can't start action annotation capture");
            this.setAnnotatorStatusWithDelayedClear("Connection to annotation coordinator is missing, so cannot start action annotation capture (reopening the connection in background); please try again after this message disappears", 3);
        }
    }

}
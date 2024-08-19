export const expectedMsgForPortDisconnection = "Attempting to use a disconnected port object";
export const pageToControllerPort = `page-actor-2-agent-controller`;
export const pageToAnnotationCoordinatorPort = `page-data-collector-2-annotation-coordinator`;
export const panelToControllerPort = "side-panel-2-agent-controller";
export const panelToAnnotationCoordinatorPort = "side-panel-2-annotation-coordinator";
export const expectedMsgForSendingRuntimeRequestFromDisconnectedContentScript = "Extension context invalidated.";

/**
 * types of one-off messages that might be sent to the service worker, either from the content script or the popup
 */
export enum PageRequestType {
    LOG = "log",
    PRESS_ENTER = "pressEnter",
    TYPE_SEQUENTIALLY = "typeSequentially",
    HOVER = "hover",
    SCREENSHOT_WITH_TARGET_HIGHLIGHTED = "screenshotWithTargetElementHighlighted",
    EULA_ACCEPTANCE = "eulaAcceptance",
}

/**
 * types of messages that the service worker might send to the side panel (for adding entries to history list, but
 * also for things like monitor mode)
 */
export enum AgentController2PanelPortMsgType {
    AGENT_CONTROLLER_READY = "agentControllerReady",
    TASK_STARTED = "taskStarted",
    ACTION_CANDIDATE = "actionCandidate",
    AUTO_MONITOR_ESCALATION = "autoMonitorEscalation",//for when the controller's "auto-monitor" feature has decided to escalate to monitor mode for a single action (to get the human user's input)
    TASK_HISTORY_ENTRY = "taskHistoryEntry",
    TASK_ENDED = "taskEnded",
    ERROR = "error",//cases where the agent controller wants to tell the side panel about a problem with some message from the side panel which was identified before a task id was generated
    NOTIFICATION = "notification",//for agent notifying side panel of non-critical problem that will delay progress on the task (so the side panel can display that to user in status field and avoid user giving up on system)
    HISTORY_EXPORT = "historyExport"//for when the controller has assembled a Blob for a zip file containing logs and/or screenshots and needs to send it to the side panel so that it can be downloaded to the user's computer
}

/**
 * types of messages that the side panel might send to the service worker
 */
export enum Panel2AgentControllerPortMsgType {
    //specific to agent controller
    START_TASK = "mustStartTask",
    KILL_TASK = "mustKillTask",
    MONITOR_APPROVED = "monitorApproved",
    MONITOR_REJECTED = "monitorRejected",
    //doesn't have to be specific to controller? handling these might be split off from AgentController later
    KEEP_ALIVE = "keepAlive",
    EXPORT_UNAFFILIATED_LOGS = "exportUnaffiliatedLogs"//i.e. logs not affiliated with any task (and so not included in any task's history export zip file)
}

/**
 * types of messages that the content script (mostly the page actor in the content script) might send to the agent
 * controller in the service worker (in the 'background') over their persistent connection
 */
export enum Page2AgentControllerPortMsgType {
    READY = "pageActorContentScriptInitializedAndReady",
    TERMINAL = "pageActorTerminalPageSideError",
    PAGE_STATE = "sendingPageState",
    ACTION_DONE = "actionPerformed"
}

export enum PanelToAnnotationCoordinatorPortMsgType {
    ANNOTATION_DETAILS = "annotationDetails",
    //todo rename to START_ANNOTATION_BATCH
    START_CAPTURER = "startCapturer",
    END_ANNOTATION_BATCH = "endAnnotationBatch",
}

export enum AnnotationCoordinator2PanelPortMsgType {
    REQ_ANNOTATION_DETAILS = "annotationDetailsRequest",
    //todo rename to refer to export of batch of annotated actions
    ANNOTATED_ACTION_EXPORT = "annotatedActionExport",
    NOTIFICATION = "annotationNotification",
}

export enum Page2AnnotationCoordinatorPortMsgType {
    READY = "dataCollectorContentScriptInitializedAndReady",
    TERMINAL = "dataCollectorTerminalPageSideError",
    PAGE_INFO = "sendingActionInfoAndContext",
    //todo entry for the start-of-batch dump of data
}

export enum AnnotationCoordinator2PagePortMsgType {
    REQ_ACTION_DETAILS_AND_CONTEXT = "requestActionDetailsAndContext",
    //todo action to request heading to top of page, then grabbing interactive elements list, then iteratively
    // taking screenshot and scrolling down; then scrolling back to top once bottom has been screen-capped and
    // sending all collected info to coordinator
}

/**
 * types of messages that the agent controller in the service worker (in the 'background') might send to the content
 * script over their persistent connection
 */
export enum AgentController2PagePortMsgType {
    REQ_PAGE_STATE = "requestPageState",
    REQ_ACTION = "requestAction",
    HIGHLIGHT_CANDIDATE_ELEM = "highlightCandidateElement",
}

export function notSameKeys<T extends object, U extends object>(obj1: T, obj2: U): boolean {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    if (keys1.length !== keys2.length) {
        return true;
    }
    return !keys1.every(key => keys2.includes(key)) || !keys2.every(key => keys1.includes(key));
}
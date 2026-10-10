// The Workflow line: one component every scope draws with (the Project, a Parent, one Task).
export { WorkflowLine, type WorkflowLineProps } from "./WorkflowLine";
export { useLineData, type LineData } from "./useLineData";
export { lineLayout, lineTopology, horizontal, crossings, densityFor, type LineTopology, type Horizontal } from "./layout";
export { scopeParam, scopeOf, scopePills, chainOf, traceOf, lineTasks, scopedLine, scopeMenu, type LineScope, type ScopeChoice, type ScopedLine, type Chain, type Trace } from "./data";
export { DONE_STATION, type LineFacts, type LineTask, type LineWorkflow } from "./model";

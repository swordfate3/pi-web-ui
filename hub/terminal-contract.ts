// Dormant v1 contracts. No listener, authorization, process or terminal is opened here.
// Parsed metadata is NOT proof of provider trust or terminal permission.
export const TERMINAL_INPUT_BYTES = 8192;

export type TerminalTarget = {
  v: 1;
  runId: string;
  runtimeId: string;
  sessionId: string;
  terminalEpoch: string;
  profile: "web-terminal-v1";
  inputState: "local" | "none" | "remote" | "fenced";
  managedRestartEligible: false;
};
export type TerminalInput = {
  v: 1;
  type: "input";
  terminalEpoch: string;
  leaseId: string;
  sequence: number;
  data: string;
};
export type TerminalIdentity = Pick<TerminalTarget, "runId" | "runtimeId" | "sessionId" | "terminalEpoch">;
export type TerminalBinding = { authorizationId: string; connectionId: string };

function record(value: unknown, keys: string): value is Record<string, unknown> {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys
  );
}
export function terminalId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}
function identityText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cs}]/u.test(value);
}
export function parseTerminalTarget(value: unknown): TerminalTarget {
  if (
    !record(value, "inputState,managedRestartEligible,profile,runId,runtimeId,sessionId,terminalEpoch,v") ||
    value.v !== 1 ||
    !terminalId(value.runId) ||
    !identityText(value.runtimeId) ||
    !identityText(value.sessionId) ||
    !terminalId(value.terminalEpoch) ||
    value.profile !== "web-terminal-v1" ||
    value.managedRestartEligible !== false ||
    !["local", "none", "remote", "fenced"].includes(value.inputState as string)
  )
    throw new Error("Invalid terminal target");
  return {
    v: 1,
    runId: value.runId,
    runtimeId: value.runtimeId,
    sessionId: value.sessionId,
    terminalEpoch: value.terminalEpoch,
    profile: "web-terminal-v1",
    inputState: value.inputState as TerminalTarget["inputState"],
    managedRestartEligible: false,
  };
}
export function parseTerminalInput(value: unknown): TerminalInput {
  if (
    !record(value, "data,leaseId,sequence,terminalEpoch,type,v") ||
    value.v !== 1 ||
    value.type !== "input" ||
    !terminalId(value.terminalEpoch) ||
    !terminalId(value.leaseId) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.data !== "string" ||
    value.data.length === 0 ||
    /\p{Cs}/u.test(value.data) ||
    Buffer.byteLength(value.data, "utf8") > TERMINAL_INPUT_BYTES
  )
    throw new Error("Invalid terminal input");
  return {
    v: 1,
    type: "input",
    terminalEpoch: value.terminalEpoch,
    leaseId: value.leaseId,
    sequence: Number(value.sequence),
    data: value.data,
  };
}
export function sameTerminal(left: TerminalIdentity, right: TerminalIdentity): boolean {
  return (
    left.runId === right.runId &&
    left.runtimeId === right.runtimeId &&
    left.sessionId === right.sessionId &&
    left.terminalEpoch === right.terminalEpoch
  );
}
export function validTerminalBinding(value: unknown): value is TerminalBinding {
  return (
    record(value, "authorizationId,connectionId") && terminalId(value.authorizationId) && terminalId(value.connectionId)
  );
}

import type { RemotePlan } from "../../../../../extensions/remote-access/plan";
import type { DeploymentMaterial } from "../../core/remote-access-materials";

export type RemoteAccessDraftState = {
  plan: RemotePlan;
  materials: DeploymentMaterial[];
  localPortEdited: boolean;
};

type PlanEditAction = {
  [K in keyof RemotePlan]: { type: "edit"; field: K; value: RemotePlan[K] };
}[keyof RemotePlan];

export type RemoteAccessDraftAction =
  | PlanEditAction
  | { type: "listener-port-received"; port: number }
  | { type: "materials-generated"; sourcePlan: RemotePlan; materials: DeploymentMaterial[] };

export function createRemoteAccessDraft(plan: RemotePlan, localPortEdited = false): RemoteAccessDraftState {
  return { plan, materials: [], localPortEdited };
}

export function remoteAccessDraftReducer(
  state: RemoteAccessDraftState,
  action: RemoteAccessDraftAction,
): RemoteAccessDraftState {
  switch (action.type) {
    case "edit":
      return {
        ...state,
        plan: { ...state.plan, [action.field]: action.value } as RemotePlan,
        materials: [],
        localPortEdited: state.localPortEdited || action.field === "localPort",
      };
    case "listener-port-received":
      if (state.localPortEdited || state.plan.localPort === action.port) return state;
      return {
        ...state,
        plan: { ...state.plan, localPort: action.port },
        materials: [],
      };
    case "materials-generated":
      if (!samePlan(state.plan, action.sourcePlan)) return state;
      return { ...state, materials: action.materials };
  }
}

function samePlan(left: RemotePlan, right: RemotePlan): boolean {
  return (Object.keys(left) as (keyof RemotePlan)[]).every((key) => left[key] === right[key]);
}

"use client";

import { createContext, useCallback, useContext, useMemo, useReducer } from "react";
import type { ConfigResponse, DashboardResponse, ScanResponse } from "./api/types";

export type FlowStep =
  | "idle"
  | "checking"
  | "scanning"
  | "review"
  | "summary"
  | "awaiting-signature"
  | "processing"
  | "dashboard";

export type ProcessingState = "authorized" | "processing" | "completed" | "failed";

export interface AppState {
  readonly step: FlowStep;
  readonly config: ConfigResponse | null;
  readonly scan: ScanResponse | null;
  readonly selectedAssetKeys: ReadonlySet<string>;
  readonly dashboard: DashboardResponse | null;
  readonly authorizationSignature: string | null;
  readonly authorizationStartedAt: number | null;
  readonly authorizationElapsedMs: number | null;
  readonly processingByAsset: ReadonlyMap<string, ProcessingState>;
  readonly error: string | null;
}

type Action =
  | { type: "SET_STEP"; step: FlowStep }
  | { type: "SET_CONFIG"; config: ConfigResponse }
  | { type: "SET_SCAN"; scan: ScanResponse }
  | { type: "TOGGLE_ASSET"; assetKey: string }
  | { type: "SET_SELECTED"; keys: readonly string[] }
  | { type: "SET_DASHBOARD"; dashboard: DashboardResponse | null }
  | { type: "START_AUTHORIZATION" }
  | { type: "AUTHORIZATION_SIGNED"; signature: string }
  | { type: "SET_ASSET_PROCESSING_STATE"; assetKey: string; state: ProcessingState }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "RESET" };

const initialState: AppState = {
  step: "idle",
  config: null,
  scan: null,
  selectedAssetKeys: new Set(),
  dashboard: null,
  authorizationSignature: null,
  authorizationStartedAt: null,
  authorizationElapsedMs: null,
  processingByAsset: new Map(),
  error: null,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "SET_STEP":
      return { ...state, step: action.step, error: null };
    case "SET_CONFIG":
      return { ...state, config: action.config };
    case "SET_SCAN": {
      const keys = new Set<string>(action.scan.selectedSplAssets.map((a) => a.assetKey));
      if (action.scan.solEligible) keys.add("SOL");
      return { ...state, scan: action.scan, selectedAssetKeys: keys };
    }
    case "TOGGLE_ASSET": {
      const next = new Set(state.selectedAssetKeys);
      if (next.has(action.assetKey)) next.delete(action.assetKey);
      else next.add(action.assetKey);
      return { ...state, selectedAssetKeys: next };
    }
    case "SET_SELECTED":
      return { ...state, selectedAssetKeys: new Set(action.keys) };
    case "SET_DASHBOARD":
      return { ...state, dashboard: action.dashboard };
    case "START_AUTHORIZATION":
      return { ...state, authorizationStartedAt: Date.now(), authorizationElapsedMs: null };
    case "AUTHORIZATION_SIGNED":
      return { ...state, authorizationSignature: action.signature };
    case "SET_ASSET_PROCESSING_STATE": {
      const next = new Map(state.processingByAsset);
      next.set(action.assetKey, action.state);
      const elapsed = state.authorizationStartedAt ? Date.now() - state.authorizationStartedAt : state.authorizationElapsedMs;
      return { ...state, processingByAsset: next, authorizationElapsedMs: elapsed };
    }
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

interface AppStateContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}

export function useAppActions() {
  const { dispatch } = useAppState();
  return {
    setStep: useCallback((step: FlowStep) => dispatch({ type: "SET_STEP", step }), [dispatch]),
    setConfig: useCallback((config: ConfigResponse) => dispatch({ type: "SET_CONFIG", config }), [dispatch]),
    setScan: useCallback((scan: ScanResponse) => dispatch({ type: "SET_SCAN", scan }), [dispatch]),
    toggleAsset: useCallback((assetKey: string) => dispatch({ type: "TOGGLE_ASSET", assetKey }), [dispatch]),
    setSelected: useCallback((keys: readonly string[]) => dispatch({ type: "SET_SELECTED", keys }), [dispatch]),
    setDashboard: useCallback((dashboard: DashboardResponse | null) => dispatch({ type: "SET_DASHBOARD", dashboard }), [dispatch]),
    startAuthorization: useCallback(() => dispatch({ type: "START_AUTHORIZATION" }), [dispatch]),
    authorizationSigned: useCallback((signature: string) => dispatch({ type: "AUTHORIZATION_SIGNED", signature }), [dispatch]),
    setAssetProcessingState: useCallback((assetKey: string, state: ProcessingState) => dispatch({ type: "SET_ASSET_PROCESSING_STATE", assetKey, state }), [dispatch]),
    setError: useCallback((error: string | null) => dispatch({ type: "SET_ERROR", error }), [dispatch]),
    reset: useCallback(() => dispatch({ type: "RESET" }), [dispatch]),
  };
}

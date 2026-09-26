/**
 * Client for the Rust harness.
 *
 * These are the existing `#[tauri::command]`s, not new ones. The workspace uses
 * `fold_ensemble` to turn a sequence artifact into a structure artifact on
 * demand, which is why the RNA view is reachable from the panel rather than
 * only from whatever tool happens to emit a structure.
 *
 * Pi still has no tool access to these commands: execution is Rust's, and the
 * webview can only ask for a capability it already declares.
 */

import { invoke } from "@tauri-apps/api/core";

export interface Fingerprint {
  tool: string;
  tool_version: string;
  artifact_sha256: string;
  adapter_sha256: string;
  algorithm: string;
  energy_model: string;
  beamsize?: number;
  cutoff?: number;
  python_version: string;
  deps_hash: string;
  harness_rev: string;
}

export interface BasePair {
  i: number;
  j: number;
  probability: number;
}

export interface FoldResult {
  sequence: string;
  structure: string;
  mfe: number;
  ensemble_free_energy?: number;
  base_pairs?: BasePair[];
  provider: string;
  fingerprint: Fingerprint;
  elapsed_ms: number;
}

export interface ToolSummary {
  name: string;
  version: string;
  source: string;
  algorithm: string;
  approximate: boolean;
  capabilities: string[];
  installed: boolean;
  healthy: boolean | null;
}

export function foldEnsemble(sequence: string): Promise<FoldResult> {
  return invoke<FoldResult>("fold_ensemble", { sequence });
}

export function foldMfe(sequence: string): Promise<FoldResult> {
  return invoke<FoldResult>("fold_mfe", { sequence });
}

export function listTools(): Promise<ToolSummary[]> {
  return invoke<ToolSummary[]>("list_tools");
}

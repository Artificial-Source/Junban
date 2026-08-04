/// <reference path="./junban-plugin-types.d.ts" />
declare module 'junban:plugin/guest@0.1.0' {
  export function activate(context: InvocationContext): void;
  export function deactivate(context: InvocationContext): void;
  export function invokeCommand(context: InvocationContext, call: CommandCall): PluginOutcome;
  export function handleEvent(context: InvocationContext, event: EventEnvelope): PluginOutcome;
  export function renderSurface(context: InvocationContext, request: SurfaceRequest): Surface;
  export function handleSurfaceAction(context: InvocationContext, action: SurfaceAction): PluginOutcome;
  export function validateSettings(context: InvocationContext, values: SettingValues): Array<ValidationIssue>;
  export function resync(context: InvocationContext, page: ResyncPage): ResyncPageOutcome;
  export function callService(context: InvocationContext, call: ServiceCall): ServiceData;
  export type InvocationContext = import('junban:plugin/types@0.1.0').InvocationContext;
  export type PluginError = import('junban:plugin/types@0.1.0').PluginError;
  export type CommandCall = import('junban:plugin/types@0.1.0').CommandCall;
  export type PluginOutcome = import('junban:plugin/types@0.1.0').PluginOutcome;
  export type EventEnvelope = import('junban:plugin/types@0.1.0').EventEnvelope;
  export type SurfaceRequest = import('junban:plugin/types@0.1.0').SurfaceRequest;
  export type Surface = import('junban:plugin/types@0.1.0').Surface;
  export type SurfaceAction = import('junban:plugin/types@0.1.0').SurfaceAction;
  export type SettingValues = import('junban:plugin/types@0.1.0').SettingValues;
  export type ValidationIssue = import('junban:plugin/types@0.1.0').ValidationIssue;
  export type ResyncPage = import('junban:plugin/types@0.1.0').ResyncPage;
  export type ResyncPageOutcome = import('junban:plugin/types@0.1.0').ResyncPageOutcome;
  export type ServiceCall = import('junban:plugin/types@0.1.0').ServiceCall;
  export type ServiceData = import('junban:plugin/types@0.1.0').ServiceData;
}

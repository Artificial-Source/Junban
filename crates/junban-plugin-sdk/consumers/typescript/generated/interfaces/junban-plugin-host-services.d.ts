/// <reference path="./junban-plugin-types.d.ts" />
declare module 'junban:plugin/host-services@0.1.0' {
  export function callService(call: ServiceCall): ServiceData;
  export type ServiceCall = import('junban:plugin/types@0.1.0').ServiceCall;
  export type ServiceData = import('junban:plugin/types@0.1.0').ServiceData;
  export type HostError = import('junban:plugin/types@0.1.0').HostError;
}

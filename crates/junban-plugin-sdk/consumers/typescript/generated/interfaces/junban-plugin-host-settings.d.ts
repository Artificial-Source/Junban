/// <reference path="./junban-plugin-types.d.ts" />
declare module 'junban:plugin/host-settings@0.1.0' {
  export function getSettings(): Array<NamedSetting>;
  export type NamedSetting = import('junban:plugin/types@0.1.0').NamedSetting;
  export type HostError = import('junban:plugin/types@0.1.0').HostError;
}

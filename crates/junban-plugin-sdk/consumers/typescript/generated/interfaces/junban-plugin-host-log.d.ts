/// <reference path="./junban-plugin-types.d.ts" />
declare module 'junban:plugin/host-log@0.1.0' {
  export function log(level: LogLevel, message: string, fields: Array<LogField>): void;
  export type LogLevel = import('junban:plugin/types@0.1.0').LogLevel;
  export type LogField = import('junban:plugin/types@0.1.0').LogField;
}

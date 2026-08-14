/// <reference path="./junban-plugin-types.d.ts" />
declare module 'junban:plugin/host-tasks@0.1.0' {
  export function queryTasks(query: TaskQuery): TaskPage;
  export type TaskQuery = import('junban:plugin/types@0.1.0').TaskQuery;
  export type TaskPage = import('junban:plugin/types@0.1.0').TaskPage;
  export type HostError = import('junban:plugin/types@0.1.0').HostError;
}

/// <reference path="./junban-plugin-types.d.ts" />
declare module 'junban:plugin/host-storage@0.1.0' {
  export function getKv(keys: Array<string>): Array<KvEntry>;
  export function listKv(cursor: string | undefined, limit: number): KvPage;
  export type KvEntry = import('junban:plugin/types@0.1.0').KvEntry;
  export type KvPage = import('junban:plugin/types@0.1.0').KvPage;
  export type HostError = import('junban:plugin/types@0.1.0').HostError;
}

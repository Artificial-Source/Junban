/** Built-in theme definitions. */

export interface Theme {
  id: string;
  name: string;
  type: "light" | "dark";
}

export const BUILT_IN_THEMES: Theme[] = [
  { id: "light", name: "Light", type: "light" },
  { id: "dark", name: "Dark", type: "dark" },
];

export const config = { legacyMode: true, label: "legacyMode" };
export function enabled(value: { legacyMode: boolean }): boolean { return value.legacyMode; }

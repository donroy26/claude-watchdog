export type Info = { mtime: number; title: string; text: string; wait?: boolean; pendingTool?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-watchdog': { watched: string[]; info: Record<string, Info>; addOpen: boolean; now: number; paneOpen: boolean }
  }
}

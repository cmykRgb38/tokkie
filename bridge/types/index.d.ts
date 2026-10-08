/** One line of Tokkie's Dock, as the app wrote it to ~/.tokkie/band.json. */
export type BandItem = { k: string; label: string; value: string; tone?: 'good' | 'warn' | 'bad' | ''; tip?: string }
export type Band = { items: BandItem[]; alert?: string; avatar?: string; showItems?: boolean; optimizer?: { model: string; mode: string } } | null
/** The Optimize button's state: working, or the last rewrite (so it can be undone). */
export type OptState = { busy: boolean; at?: number; model?: string; mode?: string; error?: string; original?: string; optimized?: string; before?: number; after?: number; changes?: string[]; questions?: string[] }

declare module 'claude-code' {
  interface PluginState {
    'tokkie-bridge': { band: Band; opt: OptState }
  }
}

/** One line of Tokkie's Dock, as the app wrote it to ~/.tokkie/band.json. */
export type BandItem = { label: string; value: string; tone?: 'good' | 'warn' | 'bad' | '' }
export type Band = { items: BandItem[]; alert?: string } | null

declare module 'claude-code' {
  interface PluginState {
    'tokkie-bridge': { band: Band }
  }
}

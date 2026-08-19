declare module '@/scene/officeScene.js' {
  export interface OfficeSceneControls {
    setAgentStates: (m: Record<string, string>) => void
    pickAt: (nx: number, ny: number) => string | null
    setTime: (minutes: number) => void
    toggleCyberpunk: () => void
    isCyberpunk: () => boolean
    destroy: () => void
  }
  export function createOfficeScene(
    container: HTMLElement,
    callbacks?: Record<string, unknown>,
  ): OfficeSceneControls
}

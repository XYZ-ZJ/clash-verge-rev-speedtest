import { getCurrentWindow } from '@tauri-apps/api/window'
import { useSyncExternalStore } from 'react'

const isDocumentVisible = () =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

let currentVisible = isDocumentVisible()
const listeners = new Set<() => void>()
let teardownListeners: (() => void) | null = null

const setVisibleState = (next: boolean) => {
  if (currentVisible === next) return
  currentVisible = next
  listeners.forEach((listener) => listener())
}

const startVisibilityListeners = () => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {}
  }
  let active = true
  let visibilityTimer: ReturnType<typeof setTimeout> | null = null
  const appWindow = getCurrentWindow()

  const updateVisible = async () => {
    const windowVisible = await appWindow.isVisible().catch(() => true)
    if (active) {
      setVisibleState(isDocumentVisible() && windowVisible)
    }
  }

  const updateVisibleSoon = () => {
    if (visibilityTimer) {
      window.clearTimeout(visibilityTimer)
    }
    visibilityTimer = window.setTimeout(() => {
      visibilityTimer = null
      void updateVisible()
    }, 50)
  }

  const handleVisibleEvent = () => {
    void updateVisible()
  }

  const handlePointerDown = () => setVisibleState(true)

  document.addEventListener('focus', handleVisibleEvent)
  document.addEventListener('pointerdown', handlePointerDown)
  document.addEventListener('visibilitychange', handleVisibleEvent)
  window.addEventListener('focus', handleVisibleEvent)

  const unlistenFocusChanged = appWindow.onFocusChanged(updateVisibleSoon)
  const unlistenCloseRequested = appWindow.onCloseRequested(() => {
    setVisibleState(false)
    updateVisibleSoon()
  })
  void updateVisible()

  return () => {
    active = false
    if (visibilityTimer) {
      window.clearTimeout(visibilityTimer)
      visibilityTimer = null
    }
    document.removeEventListener('focus', handleVisibleEvent)
    document.removeEventListener('pointerdown', handlePointerDown)
    document.removeEventListener('visibilitychange', handleVisibleEvent)
    window.removeEventListener('focus', handleVisibleEvent)
    void unlistenFocusChanged.then((unlisten) => unlisten())
    void unlistenCloseRequested.then((unlisten) => unlisten())
  }
}

const subscribeVisibility = (listener: () => void) => {
  listeners.add(listener)
  if (listeners.size === 1 && !teardownListeners) {
    teardownListeners = startVisibilityListeners()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && teardownListeners) {
      teardownListeners()
      teardownListeners = null
    }
  }
}

const getVisibilitySnapshot = () => currentVisible

export const useVisibility = () =>
  useSyncExternalStore(
    subscribeVisibility,
    getVisibilitySnapshot,
    getVisibilitySnapshot,
  )

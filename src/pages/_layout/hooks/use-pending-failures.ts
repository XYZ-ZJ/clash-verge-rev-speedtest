import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useVisibility } from '@/hooks/use-visibility'
import type { PendingFailure } from '@/services/cmds'
import { showNotice, syncSidecarFailure } from '@/services/notice-service'
import {
  usePendingFailureList,
  useSidecarFailure,
} from '@/store/app-store-context'

/** Failures handled by the recovery dialog instead of a toast. */
const CODES_SHOWN_AS_A_DIALOG = new Set<string>([
  'SYSPROXY_PRIVILEGE_REQUIRED',
  'SYSPROXY_SIDECAR_WHILE_SERVICE_READY',
])

/** Return whether a native window is visible and not minimized; fail closed. */
const windowIsWatched = async () => {
  const window = getCurrentWindow()
  try {
    const [visible, minimized] = await Promise.all([
      window.isVisible(),
      window.isMinimized(),
    ])
    return visible && !minimized
  } catch (error) {
    console.warn('[pending-failures] window state unavailable:', error)
    return false
  }
}

/** Show each pending failure sequence once when the window can be read. */
export const usePendingFailures = () => {
  const failures = usePendingFailureList()
  const sidecarFailure = useSidecarFailure()
  const pageVisible = useVisibility()
  const shownSequencesRef = useRef(new Map<string, number>())

  useEffect(() => {
    if (sidecarFailure) syncSidecarFailure(sidecarFailure)
  }, [sidecarFailure])

  useEffect(() => {
    if (!pageVisible) return
    const asToast = failures.filter(
      (failure) => !CODES_SHOWN_AS_A_DIALOG.has(failure.code),
    )
    if (asToast.length === 0) return

    let active = true
    void windowIsWatched().then((watched) => {
      if (!active || !watched) return
      for (const failure of asToast) {
        const shown = shownSequencesRef.current.get(failure.code)
        if (shown !== undefined && shown >= failure.sequence) continue
        shownSequencesRef.current.set(failure.code, failure.sequence)
        showNotice.error({ code: failure.code, detail: failure.detail })
      }
    })
    return () => {
      active = false
    }
  }, [failures, pageVisible])
}

/** Return the oldest undismissed failure owned by the dialog. */
export const useDialogFailure = () => {
  const failures = usePendingFailureList()
  const [dismissedSequence, setDismissedSequence] = useState<number | null>(
    null,
  )

  const failure: PendingFailure | null =
    failures.find((entry) => CODES_SHOWN_AS_A_DIALOG.has(entry.code)) ?? null

  const dismiss = useCallback(() => {
    setDismissedSequence(failure?.sequence ?? null)
  }, [failure])

  const shown =
    failure && failure.sequence !== dismissedSequence ? failure : null

  return { failure: shown, dismiss }
}

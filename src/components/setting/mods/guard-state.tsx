import {
  createElement,
  isValidElement,
  ReactNode,
  useEffect,
  useRef,
} from 'react'

import noop from '@/utils/noop'

interface Props<Value> {
  value?: Value
  valueProps?: string
  onChangeProps?: string
  waitTime?: number
  onChange?: (value: Value) => void
  onFormat?: (...args: any[]) => Value
  onGuard?: (value: Value, oldValue: Value) => Promise<void>
  onCatch?: (error: Error) => void
  children: ReactNode
}

export function GuardState<T>(props: Props<T>) {
  const {
    value,
    children,
    valueProps = 'value',
    onChangeProps = 'onChange',
    waitTime = 0, // debounce wait time default 0
    onGuard = noop,
    onCatch = noop,
    onChange = noop,
    onFormat,
  } = props

  const lockRef = useRef(false)
  const saveRef = useRef(value)
  const lastRef = useRef(0)
  const timeRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timeRef.current !== undefined) {
        clearTimeout(timeRef.current)
        timeRef.current = undefined
      }
    }
  }, [])

  if (!isValidElement(children)) {
    return children as any
  }

  const childProps = { ...(children.props as Record<string, any>) }

  childProps[valueProps] = value
  childProps[onChangeProps] = async (...args: any[]) => {
    if (waitTime <= 0 && lockRef.current) return

    try {
      const newValue = onFormat ? onFormat(...args) : (args[0] as T)
      onChange(newValue)

      const now = Date.now()

      if (waitTime <= 0 || now - lastRef.current >= waitTime) {
        saveRef.current = value
      }

      lastRef.current = now

      if (waitTime <= 0) {
        lockRef.current = true
        try {
          await onGuard(newValue, value!)
        } finally {
          lockRef.current = false
        }
      } else {
        if (timeRef.current !== undefined) {
          clearTimeout(timeRef.current)
        }

        timeRef.current = setTimeout(async () => {
          timeRef.current = undefined
          if (!mountedRef.current || lockRef.current) return
          lockRef.current = true
          try {
            await onGuard(newValue, saveRef.current!)
          } catch (err: any) {
            if (mountedRef.current) {
              onChange(saveRef.current!)
              onCatch(err)
            }
          } finally {
            lockRef.current = false
          }
        }, waitTime)
      }
    } catch (err: any) {
      onChange(saveRef.current!)
      onCatch(err)
      lockRef.current = false
    }
  }
  const { children: nestedChildren, ...restProps } = childProps

  return createElement(children.type, restProps, nestedChildren)
}

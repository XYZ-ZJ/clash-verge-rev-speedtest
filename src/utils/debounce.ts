export type DebouncedFn<T extends (...args: any[]) => void> = T & {
  cancel: () => void
}

export default function debounce<T extends (...args: any[]) => void>(
  func: T,
  wait: number,
): DebouncedFn<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const debounced = function (this: any, ...args: Parameters<T>) {
    if (timeout !== null) {
      clearTimeout(timeout)
    }
    timeout = setTimeout(() => {
      timeout = null
      func.apply(this, args)
    }, wait)
  } as DebouncedFn<T>
  debounced.cancel = () => {
    if (timeout !== null) {
      clearTimeout(timeout)
      timeout = null
    }
  }
  return debounced
}

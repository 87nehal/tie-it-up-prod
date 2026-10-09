// Notify all open local demo views after a successful mutation.
const CHANGE_KEY = "dms.data-change"
const CHANGE_EVENT = "dms.data-change"
export const FOCUS_KEY = "dms.focus-vehicle"
const FOCUS_EVENT = "dms.focus-change"

export function notifyDataChange() {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(CHANGE_KEY, `${Date.now()}-${Math.random()}`)
  } catch {
    /* storage may be disabled */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeDataChange(refresh: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === CHANGE_KEY) refresh()
  }
  window.addEventListener(CHANGE_EVENT, refresh)
  window.addEventListener("storage", storage)
  window.addEventListener("focus", refresh)
  return () => {
    window.removeEventListener(CHANGE_EVENT, refresh)
    window.removeEventListener("storage", storage)
    window.removeEventListener("focus", refresh)
  }
}

export function followVehicle(id: number | null) {
  if (id) localStorage.setItem(FOCUS_KEY, String(id))
  else localStorage.removeItem(FOCUS_KEY)
  window.dispatchEvent(new Event(FOCUS_EVENT))
}

export function subscribeFocus(refresh: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === FOCUS_KEY) refresh()
  }
  window.addEventListener(FOCUS_EVENT, refresh)
  window.addEventListener("storage", storage)
  return () => {
    window.removeEventListener(FOCUS_EVENT, refresh)
    window.removeEventListener("storage", storage)
  }
}

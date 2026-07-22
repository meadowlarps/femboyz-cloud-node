const KEY = 'fbc_upload_history'

export function getHistory(): string[] {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]
    } catch {
        return []
    }
}

export function addToHistory(id: string): void {
    const history = getHistory()
    if (history.includes(id)) return
    localStorage.setItem(KEY, JSON.stringify([id, ...history]))
}

export function removeFromHistory(id: string): void {
    localStorage.setItem(KEY, JSON.stringify(getHistory().filter((item) => item !== id)))
}

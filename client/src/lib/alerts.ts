import { writable } from 'svelte/store'

export type AlertType = 'info' | 'success' | 'warning' | 'error'

export type Alert = {
    id: number
    type: AlertType
    text: string
}

export const alerts = writable<Alert[]>([])

let nextId = 0

export function dismissAlert(id: number) {
    alerts.update((items) => items.filter((item) => item.id !== id))
}

export function spawnAlert(type: AlertType, text: string) {
    const id = nextId++
    alerts.update((items) => [...items, { id, type, text }])
    setTimeout(() => dismissAlert(id), 4000)
}

import { EventEmitter } from "events"

export const GlobalBus = new EventEmitter() as EventEmitter & {
  emit(event: "event", payload: { directory?: string; payload: any }): boolean
  on(event: "event", listener: (payload: { directory?: string; payload: any }) => void): EventEmitter
}

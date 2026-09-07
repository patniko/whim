let interrupt: Int32Array | undefined;
export class MaintenanceInterrupted extends Error {
  constructor() { super('Maintenance yielded to foreground storage'); }
}
export function setMaintenanceInterrupt(value?: Int32Array): void { interrupt = value; }
export function checkMaintenanceInterrupt(): void {
  if (interrupt && Atomics.load(interrupt, 0)) throw new MaintenanceInterrupted();
}

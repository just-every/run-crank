/** Registers the local key gate's check. Only the local-only dev layer calls it; a non-function clears it. */
export function registerDevAdmission(check: ((request: Request) => boolean | Promise<boolean>) | null | undefined): void;
/** True only when a registered check returns exactly true for this request; false with none registered or when it throws. */
export function devAdmitted(request: Request): Promise<boolean>;

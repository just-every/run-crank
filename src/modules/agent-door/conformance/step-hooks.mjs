import { seconds } from './crypto.mjs';

export async function nativeStepHook(c, stage, phase, step, args, outputs, result) {
 if (!c.nativeStep) return;
 await c.nativeStep({ stage, phase, now: seconds(c.now) * 1000, step: structuredClone(step), args: structuredClone(args), outputs: structuredClone(Object.fromEntries(outputs)), ...(result === undefined ? {} : { result: structuredClone(result) }), tool: c.tool });
}

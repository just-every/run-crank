import {array, bindingPattern, keys, string, strings} from './bindings.mjs';

const pathPattern = /^\/[A-Za-z0-9/_.~-]*$/;
const signInPath = value => typeof value === 'string' && /^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(value);
const validSignIn = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['path','loginHint','ownerSignIn'].includes(key))
  && signInPath(value.path)
  && typeof value.loginHint === 'boolean'
  && (value.ownerSignIn === undefined || signInPath(value.ownerSignIn));
const status = (value, label) => {
  if (!Number.isInteger(value) || value < 100 || value > 599) throw Error(`Invalid ${label}`);
};

/** Preserve source-owned preview and setup declarations, without authorizing effects. */
export function validateDeclarations(spec) {
  if (spec.providerEffects !== undefined) {
    if (strings(spec.providerEffects, 'providerEffects', /^[a-z][a-z0-9-]{0,63}$/).length > 32) throw Error('Too many provider effects');
  }
  if (spec.surfaces !== undefined) {
    keys(spec.surfaces, ['app','page','websitePreview'], 'surfaces');
    if (!spec.surfaces.app) throw Error('Surfaces require an app');
    const origins = new Map();
    for (const [name, surface] of Object.entries(spec.surfaces)) {
      keys(surface, ['path','hostnameVariable','originVariable','readiness','signIn'], 'surface');
      string(surface.path, 'surface path', pathPattern);
      if (surface.signIn !== undefined && (name !== 'app' || !validSignIn(surface.signIn))) throw Error('Invalid project sign-in declaration');
      if (surface.hostnameVariable !== undefined && surface.originVariable !== undefined) throw Error('Surface must choose one address variable');
      for (const field of ['hostnameVariable','originVariable']) if (surface[field] !== undefined) string(surface[field], field, bindingPattern);
      if (surface.originVariable !== undefined) {
        const previous = origins.get(surface.originVariable);
        if (previous !== undefined) throw Error(`Duplicate originVariable ${surface.originVariable} on surfaces.${previous} and surfaces.${name}`);
        origins.set(surface.originVariable, name);
      }
      if (surface.readiness !== undefined) {
        const probes = array(surface.readiness, 'surface readiness');
        if (!probes.length || probes.length > 32) throw Error('Invalid readiness probe count');
        for (const probe of probes) {
          keys(probe, ['path','statuses','pendingSetupStatuses'], 'readiness probe');
          string(probe.path, 'readiness path', pathPattern);
          for (const field of ['statuses','pendingSetupStatuses']) if (field === 'statuses' || probe[field] !== undefined) {
            const codes = array(probe[field], field);
            if (!codes.length || codes.length > 16 || new Set(codes).size !== codes.length) throw Error(`Invalid ${field}`);
            codes.forEach(code => status(code, field));
          }
        }
      }
    }
  }
  if (spec.initialSetup !== undefined) {
    keys(spec.initialSetup, ['path','pendingStatus','completeStatus'], 'initialSetup');
    string(spec.initialSetup.path, 'initial setup path', pathPattern);
    status(spec.initialSetup.pendingStatus, 'pending setup status');
    status(spec.initialSetup.completeStatus, 'complete setup status');
    if (spec.initialSetup.pendingStatus === spec.initialSetup.completeStatus) throw Error('Setup statuses must differ');
  }
}

// ce-cast role scopes — which roles THIS device may take.
//
// Roles are capability scopes, not hardcoded device identities. Any authorized device can take any
// role it holds; the UI shows only the role tabs the device is scoped for.
//
//   cast:publish  — may be a SOURCE (publish camera/screen/mic)
//   cast:control  — may edit the shared scene graph (layout / sources / platforms)
//   cast:compose  — may select the encoder node and Go Live
//
// Authorization is VAULT enrollment (window.CE_VAULT, secrets.js): a device enrolled in the
// operator's vault (vault-<prefix>, same origin as this app) can decrypt the publish key, so it is
// trusted to cast. An unenrolled device gets no roles and is shown how to pair. This is the seam
// where finer per-device ce-cap chains (a subset of the abilities) plug in — replace the all-roles
// grant with a parse of the device's capability and keep the rest of the app unchanged.

export const ROLES = ['cast:publish', 'cast:control', 'cast:compose'];

// Resolve this device's scopes. Returns { roles:Set<string>, has(role), authorized, deviceId }.
export async function loadScopes() {
  let deviceId = '';
  try { deviceId = await window.CE_VAULT.deviceId(); } catch {}

  let authorized = false;
  try {
    // refreshKey() returns true iff this device is enrolled in the vault AND the publish key was
    // synced into localStorage (where config.js authHeader reads it). That IS the authorization.
    authorized = await window.CE_VAULT.refreshKey();
  } catch (e) {
    authorized = false;
  }

  const roles = new Set(authorized ? ROLES : []);
  return {
    roles,
    authorized,
    deviceId,
    has(role) { return roles.has(role); },
  };
}

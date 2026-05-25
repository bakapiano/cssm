// One source of truth for "where is the ccsm backend reachable".
//
//   localhost / 127.0.0.1   →  same-origin (page IS the backend)
//   everything else         →  http://localhost:7777 (hosted frontend
//                              talks to the user's local backend via CORS)
//
// httpBase is used by fetch(); wsBase is used by WebSocket constructions.
// Keep both as functions rather than constants so the values reflect
// `location.*` at call time (matters for tests / route changes).

function isLocal() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

export function httpBase() {
  return isLocal() ? '' : 'http://localhost:7777';
}

export function wsBase() {
  if (isLocal()) {
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
  }
  return 'ws://localhost:7777';
}

export function isHostedFrontend() {
  return !isLocal();
}

/**
 * `http/auth/webauthn.ts` — SEC-02: FIDO2/WebAuthn registration and assertion.
 *
 * Four **pure** functions over `node:crypto`. No IO, no clock, no database, no library: the
 * attestation object and the COSE key are decoded here, converted to a JWK, and verified with
 * `crypto.verify`. The route layer owns the challenge cache, `user_credentials` and the session;
 * this module owns only the cryptography and the W3C checks, which makes every one of those
 * checks testable against a software authenticator without a browser.
 *
 * Why hand-rolled CBOR: the two structures WebAuthn actually needs — the attestation object
 * (`{fmt, attStmt, authData}`) and a COSE_Key map — are small, definite-length and fully
 * specified, and CTAP2 mandates canonical CBOR. A decoder that refuses indefinite lengths, tags
 * and floats covers them completely and refuses everything else (WORKPLAN WP-07: "NO NEW
 * DEPENDENCIES").
 *
 * Failure is closed. Every function returns a discriminated result rather than throwing, and the
 * default on anything unparseable, unsupported or unverifiable is `{ ok: false }` — never a
 * partial acceptance. Attestation is accepted in two forms only: `none`, and `packed` **self**
 * attestation signed by the credential key itself. `packed` with an `x5c` certificate chain is
 * rejected rather than trusted, because nothing here can validate a chain to a root.
 *
 * Checks, all mandatory (API.md §1.1 "WebAuthn", W3C §7.1/§7.2):
 *   `clientDataJSON.type`; the challenge (base64url, compared in constant time); the origin;
 *   `rpIdHash == sha256(rpId)`; the User Present flag; the User Verified flag when required; the
 *   signature over `authData || sha256(clientDataJSON)`; and a `sign_count` that did not go
 *   backwards — a counter `<=` the stored one, when either is non-zero, is a cloned authenticator
 *   and is rejected (SEC-02, the named acceptance).
 */

import {
  constants as cryptoConstants,
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@terminal/sdk/wire/rest/auth';

/* ------------------------------------------------------------------ constants */

/** COSE algorithm identifiers (IANA COSE Algorithms) this server accepts. */
export const COSE_ES256 = -7;
export const COSE_RS256 = -257;

/** The `pubKeyCredParams` offered at registration, most preferred first. */
export const SUPPORTED_ALGORITHMS: readonly number[] = [COSE_ES256, COSE_RS256];

/** Matches the 5-minute challenge cache of API.md §1.3. */
export const WEBAUTHN_TIMEOUT_MS = 300_000;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const COSE_KTY_EC2 = 2;
const COSE_KTY_RSA = 3;
const COSE_CRV_P256 = 1;

/* --------------------------------------------------------------------- results */

export interface RegistrationVerified {
  ok: true;
  /** Raw credential id from the attested credential data. */
  credentialId: Uint8Array;
  /** The COSE_Key bytes exactly as the authenticator produced them (`user_credentials.public_key`). */
  publicKey: Uint8Array;
  signCount: number;
  /** Lower-case UUID, or `null` when the authenticator reported the all-zero AAGUID. */
  aaguid: string | null;
  transports: string[];
}

export interface AuthenticationVerified {
  ok: true;
  newSignCount: number;
}

export interface VerificationFailed {
  ok: false;
  /** A stable machine-readable cause; safe to log, never contains key material. */
  reason: string;
}

export type RegistrationResult = RegistrationVerified | VerificationFailed;
export type AuthenticationResult = AuthenticationVerified | VerificationFailed;

/* ------------------------------------------------------------------- encoding */

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Strict base64url → bytes. Returns `null` for anything outside the base64url alphabet. */
function fromBase64Url(value: string): Uint8Array | null {
  if (!B64URL_RE.test(value)) return null;
  const buf = Buffer.from(value, 'base64url');
  // `Buffer.from` silently truncates a dangling 1-character group; reject rather than accept a
  // prefix of what the client sent.
  if (buf.length === 0 && value.length > 0) return null;
  return new Uint8Array(buf);
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * Constant-time byte comparison that does not leak the length either: both sides are hashed
 * first, so the comparison is always over 32 bytes.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/* ----------------------------------------------------------------------- CBOR */

interface CborRead {
  value: unknown;
  next: number;
}

/** Definite-length CBOR only — no tags, no floats, no indefinite lengths (CTAP2 canonical). */
function decodeCbor(buf: Uint8Array, offset: number): CborRead {
  if (offset >= buf.length) throw new Error('cbor: truncated');
  const initial = buf[offset]!;
  const major = initial >> 5;
  const additional = initial & 0x1f;
  let pos = offset + 1;
  let argument = 0;

  if (additional < 24) {
    argument = additional;
  } else if (additional === 24) {
    if (pos + 1 > buf.length) throw new Error('cbor: truncated');
    argument = buf[pos]!;
    pos += 1;
  } else if (additional === 25) {
    if (pos + 2 > buf.length) throw new Error('cbor: truncated');
    argument = (buf[pos]! << 8) | buf[pos + 1]!;
    pos += 2;
  } else if (additional === 26) {
    if (pos + 4 > buf.length) throw new Error('cbor: truncated');
    argument = buf[pos]! * 0x1000000 + (buf[pos + 1]! << 16) + (buf[pos + 2]! << 8) + buf[pos + 3]!;
    pos += 4;
  } else if (additional === 27) {
    if (pos + 8 > buf.length) throw new Error('cbor: truncated');
    let big = 0n;
    for (let i = 0; i < 8; i += 1) big = (big << 8n) | BigInt(buf[pos + i]!);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: integer out of range');
    argument = Number(big);
    pos += 8;
  } else {
    // 28-30 are reserved; 31 is an indefinite length.
    throw new Error('cbor: unsupported additional information');
  }

  switch (major) {
    case 0:
      return { value: argument, next: pos };
    case 1:
      return { value: -1 - argument, next: pos };
    case 2: {
      if (pos + argument > buf.length) throw new Error('cbor: truncated byte string');
      return { value: buf.subarray(pos, pos + argument), next: pos + argument };
    }
    case 3: {
      if (pos + argument > buf.length) throw new Error('cbor: truncated text string');
      const text = Buffer.from(
        buf.buffer,
        buf.byteOffset + pos,
        argument,
      ).toString('utf8');
      return { value: text, next: pos + argument };
    }
    case 4: {
      const items: unknown[] = [];
      let cursor = pos;
      for (let i = 0; i < argument; i += 1) {
        const item = decodeCbor(buf, cursor);
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      let cursor = pos;
      for (let i = 0; i < argument; i += 1) {
        const key = decodeCbor(buf, cursor);
        const val = decodeCbor(buf, key.next);
        if (typeof key.value !== 'string' && typeof key.value !== 'number') {
          throw new Error('cbor: unsupported map key');
        }
        map.set(key.value, val.value);
        cursor = val.next;
      }
      return { value: map, next: cursor };
    }
    case 7: {
      if (additional === 20) return { value: false, next: pos };
      if (additional === 21) return { value: true, next: pos };
      if (additional === 22) return { value: null, next: pos };
      throw new Error('cbor: unsupported simple value');
    }
    default:
      // Major type 6 (tagged) has no place in an attestation object or a COSE key.
      throw new Error('cbor: unsupported major type');
  }
}

function asBytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

/** `instanceof Map` alone narrows to `Map<any, any>`; this keeps the values `unknown`. */
function asCborMap(value: unknown): Map<unknown, unknown> | null {
  return value instanceof Map ? (value as Map<unknown, unknown>) : null;
}

/* ------------------------------------------------------------------ COSE keys */

interface CoseKey {
  alg: number;
  key: KeyObject;
}

/** Strip the leading zero bytes a big-endian integer must not carry in a JWK. */
function trimLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  return bytes.subarray(start);
}

/** Left-pad an EC coordinate to the curve's field size; reject anything longer. */
function padCoordinate(bytes: Uint8Array, size: number): Uint8Array | null {
  const trimmed = bytes.length > size ? trimLeadingZeros(bytes) : bytes;
  if (trimmed.length > size) return null;
  if (trimmed.length === size) return trimmed;
  const out = new Uint8Array(size);
  out.set(trimmed, size - trimmed.length);
  return out;
}

/**
 * Decode a COSE_Key map into a verifiable `KeyObject`. ES256 (`-7`, P-256) and RS256 (`-257`)
 * only: an algorithm this server did not offer is rejected, not trusted.
 */
function coseToKey(coseBytes: Uint8Array): CoseKey | { reason: string } {
  let decoded: CborRead;
  try {
    decoded = decodeCbor(coseBytes, 0);
  } catch {
    return { reason: 'cose_key_malformed' };
  }
  const map = asCborMap(decoded.value);
  if (!map) return { reason: 'cose_key_not_a_map' };

  const kty = map.get(1);
  const alg = map.get(3);
  if (typeof kty !== 'number' || typeof alg !== 'number') return { reason: 'cose_key_incomplete' };

  let jwk: JsonWebKey;
  if (alg === COSE_ES256) {
    if (kty !== COSE_KTY_EC2) return { reason: 'cose_key_alg_kty_mismatch' };
    if (map.get(-1) !== COSE_CRV_P256) return { reason: 'cose_key_unsupported_curve' };
    const rawX = asBytes(map.get(-2));
    const rawY = asBytes(map.get(-3));
    if (!rawX || !rawY) return { reason: 'cose_key_incomplete' };
    const x = padCoordinate(rawX, 32);
    const y = padCoordinate(rawY, 32);
    if (!x || !y) return { reason: 'cose_key_bad_coordinate' };
    jwk = { kty: 'EC', crv: 'P-256', x: toBase64Url(x), y: toBase64Url(y) };
  } else if (alg === COSE_RS256) {
    if (kty !== COSE_KTY_RSA) return { reason: 'cose_key_alg_kty_mismatch' };
    const n = asBytes(map.get(-1));
    const e = asBytes(map.get(-2));
    if (!n || !e) return { reason: 'cose_key_incomplete' };
    if (n.length < 256) return { reason: 'cose_key_modulus_too_small' };
    jwk = { kty: 'RSA', n: toBase64Url(trimLeadingZeros(n)), e: toBase64Url(trimLeadingZeros(e)) };
  } else {
    return { reason: 'cose_key_unsupported_algorithm' };
  }

  try {
    return { alg, key: createPublicKey({ key: jwk, format: 'jwk' }) };
  } catch {
    return { reason: 'cose_key_rejected' };
  }
}

/** `authData || sha256(clientDataJSON)` verified under the credential key. */
function verifySignature(cose: CoseKey, signedData: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (cose.alg === COSE_ES256) {
      return cryptoVerify('sha256', signedData, { key: cose.key, dsaEncoding: 'der' }, signature);
    }
    return cryptoVerify(
      'sha256',
      signedData,
      { key: cose.key, padding: cryptoConstants.RSA_PKCS1_PADDING },
      signature,
    );
  } catch {
    // A malformed DER signature makes OpenSSL throw; that is a failed verification, not an error.
    return false;
  }
}

/* -------------------------------------------------------------- authenticator data */

interface AttestedCredential {
  aaguid: Uint8Array;
  credentialId: Uint8Array;
  coseKeyBytes: Uint8Array;
}

interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  attested: AttestedCredential | null;
}

function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData | { reason: string } {
  if (bytes.length < 37) return { reason: 'auth_data_too_short' };
  const rpIdHash = bytes.subarray(0, 32);
  const flags = bytes[32]!;
  const signCount =
    bytes[33]! * 0x1000000 + (bytes[34]! << 16) + (bytes[35]! << 8) + bytes[36]!;

  if ((flags & FLAG_AT) === 0) {
    return { rpIdHash, flags, signCount, attested: null };
  }

  if (bytes.length < 55) return { reason: 'attested_credential_truncated' };
  const aaguid = bytes.subarray(37, 53);
  const credIdLen = (bytes[53]! << 8) | bytes[54]!;
  const credIdEnd = 55 + credIdLen;
  if (credIdLen === 0 || credIdLen > 1023 || bytes.length < credIdEnd) {
    return { reason: 'attested_credential_truncated' };
  }
  const credentialId = bytes.subarray(55, credIdEnd);

  // The COSE key is self-delimiting; its end is wherever the CBOR item ends, which is also where
  // the optional extension map begins.
  let keyEnd: number;
  try {
    keyEnd = decodeCbor(bytes, credIdEnd).next;
  } catch {
    return { reason: 'cose_key_malformed' };
  }
  return {
    rpIdHash,
    flags,
    signCount,
    attested: { aaguid, credentialId, coseKeyBytes: bytes.subarray(credIdEnd, keyEnd) },
  };
}

function aaguidToUuid(aaguid: Uint8Array): string | null {
  if (aaguid.length !== 16 || aaguid.every((b) => b === 0)) return null;
  const hex = Buffer.from(aaguid.buffer, aaguid.byteOffset, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* -------------------------------------------------------------- client data JSON */

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

function parseClientData(encoded: string): ClientData | { reason: string } {
  const raw = fromBase64Url(encoded);
  if (!raw) return { reason: 'client_data_not_base64url' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8'));
  } catch {
    return { reason: 'client_data_not_json' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { reason: 'client_data_not_json' };
  const obj = parsed as Record<string, unknown>;
  const { type, challenge, origin } = obj;
  if (typeof type !== 'string' || typeof challenge !== 'string' || typeof origin !== 'string') {
    return { reason: 'client_data_incomplete' };
  }
  return { type, challenge, origin };
}

/**
 * The checks shared by registration and assertion: `type`, challenge, origin, `rpIdHash`, UP
 * and (when required) UV. Returns the raw clientDataJSON bytes so the caller can hash them.
 */
function checkCeremony(input: {
  clientDataJSON: string;
  expectedType: string;
  expectedChallenge: Uint8Array;
  rpId: string;
  origin: string;
  flags: number;
  rpIdHash: Uint8Array;
  requireUserVerification: boolean;
}): { clientDataBytes: Uint8Array } | { reason: string } {
  const clientDataBytes = fromBase64Url(input.clientDataJSON);
  if (!clientDataBytes) return { reason: 'client_data_not_base64url' };

  const clientData = parseClientData(input.clientDataJSON);
  if ('reason' in clientData) return clientData;

  if (clientData.type !== input.expectedType) return { reason: 'client_data_type_mismatch' };

  const challenge = fromBase64Url(clientData.challenge);
  if (!challenge) return { reason: 'challenge_not_base64url' };
  if (!constantTimeEqual(challenge, input.expectedChallenge)) {
    return { reason: 'challenge_mismatch' };
  }

  if (clientData.origin !== input.origin) return { reason: 'origin_mismatch' };

  if (!constantTimeEqual(input.rpIdHash, sha256(Buffer.from(input.rpId, 'utf8')))) {
    return { reason: 'rp_id_hash_mismatch' };
  }

  if ((input.flags & FLAG_UP) === 0) return { reason: 'user_not_present' };
  if (input.requireUserVerification && (input.flags & FLAG_UV) === 0) {
    return { reason: 'user_not_verified' };
  }

  return { clientDataBytes };
}

/* ------------------------------------------------------------------- ceremonies */

export interface RegistrationOptionsInput {
  userId: number;
  email: string;
  displayName: string;
  challenge: Uint8Array;
  rpId: string;
  rpName: string;
  /** Credential ids already registered for this user; offered as `excludeCredentials`. */
  existing: readonly Uint8Array[];
}

/**
 * `POST /auth/webauthn/register/options` — the creation options handed to the browser.
 * Pure: the caller mints and caches the challenge.
 */
export function registrationOptions(
  input: RegistrationOptionsInput,
): PublicKeyCredentialCreationOptionsJSON {
  return {
    rp: { id: input.rpId, name: input.rpName },
    // `user.id` is an opaque byte string, not a display value: the decimal user id, UTF-8.
    user: {
      id: toBase64Url(Buffer.from(String(input.userId), 'utf8')),
      name: input.email,
      displayName: input.displayName,
    },
    challenge: toBase64Url(input.challenge),
    pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
    timeout: WEBAUTHN_TIMEOUT_MS,
    excludeCredentials: input.existing.map((id) => ({
      type: 'public-key' as const,
      id: toBase64Url(id),
    })),
    // `required`, not `preferred`: `routes/auth.ts` verifies BOTH ceremonies with
    // `requireUserVerification: true`, so an authenticator that honours `preferred` and skips user
    // verification would produce exactly the response the server then rejects. The ceremony the
    // client is told to run must be the one the server will accept.
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    // Nothing here can validate an attestation chain, so none is asked for (W3C §14.4.1).
    attestation: 'none',
  };
}

export interface AuthenticationOptionsInput {
  challenge: Uint8Array;
  rpId: string;
  allowCredentials: readonly Uint8Array[];
}

/** `POST /auth/webauthn/login/options` — the request options handed to the browser. */
export function authenticationOptions(
  input: AuthenticationOptionsInput,
): PublicKeyCredentialRequestOptionsJSON {
  return {
    challenge: toBase64Url(input.challenge),
    timeout: WEBAUTHN_TIMEOUT_MS,
    rpId: input.rpId,
    allowCredentials: input.allowCredentials.map((id) => ({
      type: 'public-key' as const,
      id: toBase64Url(id),
    })),
    // Matches the server's `requireUserVerification: true` — see `registrationOptions`.
    userVerification: 'required',
  };
}

export interface VerifyRegistrationInput {
  response: RegistrationResponseJSON;
  expectedChallenge: Uint8Array;
  rpId: string;
  origin: string;
  /** Demand the UV flag (an MFA ceremony rather than a second factor of possession only). */
  requireUserVerification?: boolean;
}

/**
 * `POST /auth/webauthn/register/verify` — W3C §7.1. Returns the columns of
 * `user_credentials (kind='webauthn')` on success and a reason on every failure.
 */
export function verifyRegistration(input: VerifyRegistrationInput): RegistrationResult {
  const attestationBytes = fromBase64Url(input.response.response.attestationObject);
  if (!attestationBytes) return { ok: false, reason: 'attestation_not_base64url' };

  let attestation: CborRead;
  try {
    attestation = decodeCbor(attestationBytes, 0);
  } catch {
    return { ok: false, reason: 'attestation_malformed' };
  }
  const attestationMap = asCborMap(attestation.value);
  if (!attestationMap) return { ok: false, reason: 'attestation_malformed' };

  const fmt = attestationMap.get('fmt');
  const attStmt = asCborMap(attestationMap.get('attStmt'));
  const authDataBytes = asBytes(attestationMap.get('authData'));
  if (typeof fmt !== 'string' || !attStmt || !authDataBytes) {
    return { ok: false, reason: 'attestation_incomplete' };
  }

  const authData = parseAuthenticatorData(authDataBytes);
  if ('reason' in authData) return { ok: false, reason: authData.reason };
  if (!authData.attested) return { ok: false, reason: 'attested_credential_missing' };

  const ceremony = checkCeremony({
    clientDataJSON: input.response.response.clientDataJSON,
    expectedType: 'webauthn.create',
    expectedChallenge: input.expectedChallenge,
    rpId: input.rpId,
    origin: input.origin,
    flags: authData.flags,
    rpIdHash: authData.rpIdHash,
    requireUserVerification: input.requireUserVerification === true,
  });
  if ('reason' in ceremony) return { ok: false, reason: ceremony.reason };

  const cose = coseToKey(authData.attested.coseKeyBytes);
  if (!('key' in cose)) return { ok: false, reason: cose.reason };

  // The credential the client claims must be the one the authenticator attested.
  const rawId = fromBase64Url(input.response.rawId);
  if (!rawId) return { ok: false, reason: 'raw_id_not_base64url' };
  if (
    rawId.length !== authData.attested.credentialId.length ||
    !constantTimeEqual(rawId, authData.attested.credentialId)
  ) {
    return { ok: false, reason: 'credential_id_mismatch' };
  }

  const clientDataHash = sha256(ceremony.clientDataBytes);

  if (fmt === 'none') {
    // W3C §8.7: the `none` statement is the empty map. Anything else is a statement we would be
    // ignoring rather than verifying.
    if (attStmt.size !== 0) return { ok: false, reason: 'attestation_none_not_empty' };
  } else if (fmt === 'packed') {
    if (attStmt.has('x5c') || attStmt.has('ecdaaKeyId')) {
      // A chain we cannot validate to a trusted root is worse than no attestation at all.
      return { ok: false, reason: 'attestation_x5c_unsupported' };
    }
    const attAlg = attStmt.get('alg');
    const attSig = asBytes(attStmt.get('sig'));
    if (typeof attAlg !== 'number' || !attSig) {
      return { ok: false, reason: 'attestation_packed_incomplete' };
    }
    if (attAlg !== cose.alg) return { ok: false, reason: 'attestation_alg_mismatch' };
    const signed = Buffer.concat([authDataBytes, clientDataHash]);
    if (!verifySignature(cose, signed, attSig)) {
      return { ok: false, reason: 'attestation_signature_invalid' };
    }
  } else {
    return { ok: false, reason: 'attestation_format_unsupported' };
  }

  const transports = input.response.response.transports;
  return {
    ok: true,
    credentialId: Uint8Array.from(authData.attested.credentialId),
    publicKey: Uint8Array.from(authData.attested.coseKeyBytes),
    signCount: authData.signCount,
    aaguid: aaguidToUuid(authData.attested.aaguid),
    transports: Array.isArray(transports) ? [...transports] : [],
  };
}

export interface VerifyAuthenticationInput {
  response: AuthenticationResponseJSON;
  expectedChallenge: Uint8Array;
  rpId: string;
  origin: string;
  /** The stored `user_credentials.public_key` — the COSE_Key bytes registration returned. */
  publicKey: Uint8Array;
  storedSignCount: number;
  requireUserVerification?: boolean;
}

/**
 * `POST /auth/webauthn/login/verify` — W3C §7.2. On success the caller writes `newSignCount`
 * back to `user_credentials.sign_count` and stamps `last_used_at`.
 */
export function verifyAuthentication(input: VerifyAuthenticationInput): AuthenticationResult {
  const authDataBytes = fromBase64Url(input.response.response.authenticatorData);
  if (!authDataBytes) return { ok: false, reason: 'auth_data_not_base64url' };

  const authData = parseAuthenticatorData(authDataBytes);
  if ('reason' in authData) return { ok: false, reason: authData.reason };

  const ceremony = checkCeremony({
    clientDataJSON: input.response.response.clientDataJSON,
    expectedType: 'webauthn.get',
    expectedChallenge: input.expectedChallenge,
    rpId: input.rpId,
    origin: input.origin,
    flags: authData.flags,
    rpIdHash: authData.rpIdHash,
    requireUserVerification: input.requireUserVerification === true,
  });
  if ('reason' in ceremony) return { ok: false, reason: ceremony.reason };

  const cose = coseToKey(input.publicKey);
  if (!('key' in cose)) return { ok: false, reason: cose.reason };

  const signature = fromBase64Url(input.response.response.signature);
  if (!signature || signature.length === 0) return { ok: false, reason: 'signature_not_base64url' };

  const signed = Buffer.concat([authDataBytes, sha256(ceremony.clientDataBytes)]);
  if (!verifySignature(cose, signed, signature)) {
    return { ok: false, reason: 'signature_invalid' };
  }

  // SEC-02. A counter that did not advance, when either side is non-zero, is the signature of a
  // cloned authenticator replaying a captured assertion (W3C §6.1.1 step 21). Authenticators that
  // do not implement a counter report zero forever and are the only case exempted.
  if (authData.signCount !== 0 || input.storedSignCount !== 0) {
    if (authData.signCount <= input.storedSignCount) {
      return { ok: false, reason: 'sign_count_rollback' };
    }
  }

  return { ok: true, newSignCount: authData.signCount };
}

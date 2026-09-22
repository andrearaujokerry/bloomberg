/**
 * SEC-02 — `packages/server/test/integration/auth/webauthn.test.ts`
 *
 * WORKPLAN WP-07 acceptance: "registration and assertion, `sign_count` rollback rejected".
 *
 * There are no fixtures here. The test builds a **software authenticator** on `node:crypto`: it
 * generates a real P-256 (and, in one case, a real RSA) key pair, assembles the authenticator data
 * byte by byte, CBOR-encodes the COSE key and the attestation object itself, and signs
 * `authData || sha256(clientDataJSON)` with the private key. So every passing assertion below is a
 * signature the implementation actually verified, and every rejection is a property of the
 * verifier rather than of a canned blob.
 *
 * Each mandatory check has a case that only passes because the check is there: `clientData.type`,
 * the challenge, the origin, the `rpIdHash`, the User Present flag, User Verified when required,
 * the signature, and the sign-count rollback.
 *
 * The credential round-trips through `user_credentials` (`kind='webauthn'`) inside `withTxDb()`, so
 * the stored `public_key` bytes — not an in-memory `KeyObject` — are what verifies the assertion.
 */

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  COSE_ES256,
  COSE_RS256,
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../../../src/http/auth/webauthn.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@terminal/sdk/wire/rest/auth';

const t = withTxDb();

const RP_ID = 'terminal.test';
const RP_NAME = 'Terminal';
const ORIGIN = 'https://terminal.test';

/* ------------------------------------------------------------------ CBOR encoder
 * The mirror of the decoder under test: definite lengths only, which is all CTAP2 emits. */

function cborHead(major: number, argument: number): Buffer {
  if (argument < 24) return Buffer.from([(major << 5) | argument]);
  if (argument < 0x100) return Buffer.from([(major << 5) | 24, argument]);
  if (argument < 0x10000) {
    return Buffer.from([(major << 5) | 25, argument >> 8, argument & 0xff]);
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(argument, 1);
  return head;
}

function cborInt(value: number): Buffer {
  return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
}
function cborBytes(value: Uint8Array): Buffer {
  return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
}
function cborText(value: string): Buffer {
  const utf8 = Buffer.from(value, 'utf8');
  return Buffer.concat([cborHead(3, utf8.length), utf8]);
}
function cborArray(items: readonly Buffer[]): Buffer {
  return Buffer.concat([cborHead(4, items.length), ...items]);
}
function cborMap(entries: readonly (readonly [Buffer, Buffer])[]): Buffer {
  return Buffer.concat([cborHead(5, entries.length), ...entries.map(([k, v]) => Buffer.concat([k, v]))]);
}

/* ---------------------------------------------------------- software authenticator */

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

interface CeremonyOptions {
  rpId?: string;
  origin?: string;
  type?: string;
  flags?: number;
  signCount?: number;
}

interface RegisterOptions extends CeremonyOptions {
  /** 'none' (default) or 'packed' self-attestation. */
  attestationFormat?: 'none' | 'packed';
  /** Forge a `packed` statement carrying a certificate chain the verifier cannot validate. */
  withX5c?: boolean;
  /** Corrupt the packed attestation signature after it is produced. */
  tamperAttestationSignature?: boolean;
  /** Claim a `rawId` other than the attested credential id. */
  rawIdOverride?: Uint8Array;
}

interface AssertOptions extends CeremonyOptions {
  tamperSignature?: boolean;
}

/**
 * A FIDO2 authenticator, in the test process. `alg` selects ES256 (P-256) or RS256 (RSA-2048);
 * both are the algorithms `registrationOptions()` offers.
 */
class SoftwareAuthenticator {
  readonly credentialId: Buffer;
  readonly aaguid: Buffer;
  private readonly privateKey;
  private readonly cose: Buffer;
  private readonly alg: number;

  constructor(alg: number = COSE_ES256, aaguid: Buffer = randomBytes(16)) {
    this.alg = alg;
    this.credentialId = randomBytes(32);
    this.aaguid = aaguid;
    if (alg === COSE_ES256) {
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      this.privateKey = pair.privateKey;
      const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
      this.cose = cborMap([
        [cborInt(1), cborInt(2)], // kty: EC2
        [cborInt(3), cborInt(COSE_ES256)],
        [cborInt(-1), cborInt(1)], // crv: P-256
        [cborInt(-2), cborBytes(Buffer.from(jwk.x, 'base64url'))],
        [cborInt(-3), cborBytes(Buffer.from(jwk.y, 'base64url'))],
      ]);
    } else {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      this.privateKey = pair.privateKey;
      const jwk = pair.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
      this.cose = cborMap([
        [cborInt(1), cborInt(3)], // kty: RSA
        [cborInt(3), cborInt(COSE_RS256)],
        [cborInt(-1), cborBytes(Buffer.from(jwk.n, 'base64url'))],
        [cborInt(-2), cborBytes(Buffer.from(jwk.e, 'base64url'))],
      ]);
    }
  }

  get coseKey(): Buffer {
    return this.cose;
  }

  private signBytes(data: Uint8Array): Buffer {
    return this.alg === COSE_ES256
      ? sign('sha256', data, { key: this.privateKey, dsaEncoding: 'der' })
      : sign('sha256', data, this.privateKey);
  }

  private authData(opts: {
    rpId: string;
    flags: number;
    signCount: number;
    attested: boolean;
  }): Buffer {
    const head = Buffer.alloc(37);
    sha256(Buffer.from(opts.rpId, 'utf8')).copy(head, 0);
    head[32] = opts.flags;
    head.writeUInt32BE(opts.signCount, 33);
    if (!opts.attested) return head;
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.credentialId.length, 0);
    return Buffer.concat([head, this.aaguid, credLen, this.credentialId, this.cose]);
  }

  private clientData(type: string, challenge: Uint8Array, origin: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge: b64u(challenge), origin, crossOrigin: false }),
      'utf8',
    );
  }

  register(challenge: Uint8Array, opts: RegisterOptions = {}): RegistrationResponseJSON {
    const rpId = opts.rpId ?? RP_ID;
    const flags = opts.flags ?? FLAG_UP | FLAG_UV | FLAG_AT;
    const authData = this.authData({
      rpId,
      flags,
      signCount: opts.signCount ?? 0,
      attested: (flags & FLAG_AT) !== 0,
    });
    const clientDataJSON = this.clientData(
      opts.type ?? 'webauthn.create',
      challenge,
      opts.origin ?? ORIGIN,
    );

    let attStmt = cborMap([]);
    if (opts.attestationFormat === 'packed') {
      const signature = this.signBytes(Buffer.concat([authData, sha256(clientDataJSON)]));
      if (opts.tamperAttestationSignature) signature[signature.length - 1] ^= 0xff;
      const entries: (readonly [Buffer, Buffer])[] = [
        [cborText('alg'), cborInt(this.alg)],
        [cborText('sig'), cborBytes(signature)],
      ];
      if (opts.withX5c) entries.push([cborText('x5c'), cborArray([cborBytes(randomBytes(64))])]);
      attStmt = cborMap(entries);
    }

    const attestationObject = cborMap([
      [cborText('fmt'), cborText(opts.attestationFormat ?? 'none')],
      [cborText('attStmt'), attStmt],
      [cborText('authData'), cborBytes(authData)],
    ]);

    const rawId = b64u(opts.rawIdOverride ?? this.credentialId);
    return {
      id: rawId,
      rawId,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['usb', 'nfc'],
      },
      clientExtensionResults: {},
    };
  }

  assert(challenge: Uint8Array, opts: AssertOptions = {}): AuthenticationResponseJSON {
    const rpId = opts.rpId ?? RP_ID;
    const flags = opts.flags ?? FLAG_UP | FLAG_UV;
    const authData = this.authData({
      rpId,
      flags,
      signCount: opts.signCount ?? 1,
      attested: false,
    });
    const clientDataJSON = this.clientData(
      opts.type ?? 'webauthn.get',
      challenge,
      opts.origin ?? ORIGIN,
    );
    const signature = this.signBytes(Buffer.concat([authData, sha256(clientDataJSON)]));
    if (opts.tamperSignature) signature[signature.length - 1] ^= 0xff;

    const rawId = b64u(this.credentialId);
    return {
      id: rawId,
      rawId,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: null,
      },
      clientExtensionResults: {},
    };
  }
}

/* -------------------------------------------------------------------- fixtures */

interface SeededUser {
  userId: number;
  firmId: number;
  email: string;
  displayName: string;
}

async function seedUser(db: TestDb): Promise<SeededUser> {
  const firm = await db.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`WebAuthn Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const email = `wa-${randomUUID()}@demo.invalid`;
  const displayName = 'WebAuthn Tester';
  const user = await db.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role, mfa_required)
     VALUES ($1, $2, $3, 'user', true) RETURNING user_id`,
    [firmId, email, displayName],
  );
  return { userId: Number(user.rows[0]!.user_id), firmId, email, displayName };
}

interface StoredCredential {
  credentialPk: number;
  credentialId: Buffer;
  publicKey: Buffer;
  signCount: number;
  aaguid: string | null;
  transports: string[] | null;
}

async function storeCredential(
  db: TestDb,
  userId: number,
  verified: {
    credentialId: Uint8Array;
    publicKey: Uint8Array;
    signCount: number;
    aaguid: string | null;
    transports: string[];
  },
): Promise<number> {
  const row = await db.client.query<{ credential_pk: string }>(
    `INSERT INTO user_credentials (user_id, kind, credential_id, public_key, sign_count, aaguid, transports)
     VALUES ($1, 'webauthn', $2, $3, $4, $5, $6) RETURNING credential_pk`,
    [
      userId,
      Buffer.from(verified.credentialId),
      Buffer.from(verified.publicKey),
      verified.signCount,
      verified.aaguid,
      verified.transports,
    ],
  );
  return Number(row.rows[0]!.credential_pk);
}

async function loadCredential(db: TestDb, credentialId: Uint8Array): Promise<StoredCredential> {
  const row = await db.client.query<{
    credential_pk: string;
    credential_id: Buffer;
    public_key: Buffer;
    sign_count: string;
    aaguid: string | null;
    transports: string[] | null;
  }>(
    `SELECT credential_pk, credential_id, public_key, sign_count, aaguid, transports
       FROM user_credentials
      WHERE kind = 'webauthn' AND credential_id = $1 AND revoked_at IS NULL`,
    [Buffer.from(credentialId)],
  );
  const found = row.rows[0];
  if (!found) throw new Error('credential not found');
  return {
    credentialPk: Number(found.credential_pk),
    credentialId: found.credential_id,
    publicKey: found.public_key,
    signCount: Number(found.sign_count),
    aaguid: found.aaguid,
    transports: found.transports,
  };
}

/* ----------------------------------------------------------------------- tests */

describe('webauthn — ceremony options', () => {
  it('offers ES256 and RS256, the rp, the user handle and the registered credentials', () => {
    const challenge = randomBytes(32);
    const existing = [randomBytes(32), randomBytes(16)];
    const options = registrationOptions({
      userId: 4242,
      email: 'trader@demo.invalid',
      displayName: 'A Trader',
      challenge,
      rpId: RP_ID,
      rpName: RP_NAME,
      existing,
    });

    expect(options.rp).toEqual({ id: RP_ID, name: RP_NAME });
    expect(options.challenge).toBe(b64u(challenge));
    expect(Buffer.from(options.user.id, 'base64url').toString('utf8')).toBe('4242');
    expect(options.user.name).toBe('trader@demo.invalid');
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([COSE_ES256, COSE_RS256]);
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual(existing.map((e) => b64u(e)));
    expect(options.attestation).toBe('none');
  });

  it('builds request options with the caller allow-list', () => {
    const challenge = randomBytes(32);
    const credentialId = randomBytes(32);
    const options = authenticationOptions({ challenge, rpId: RP_ID, allowCredentials: [credentialId] });
    expect(options.challenge).toBe(b64u(challenge));
    expect(options.rpId).toBe(RP_ID);
    expect(options.allowCredentials).toEqual([{ type: 'public-key', id: b64u(credentialId) }]);
  });
});

describe('webauthn — registration', () => {
  it('registers an ES256 credential and persists it to user_credentials', async () => {
    const user = await seedUser(t);
    const authenticator = new SoftwareAuthenticator();
    const challenge = randomBytes(32);

    const result = verifyRegistration({
      response: authenticator.register(challenge),
      expectedChallenge: challenge,
      rpId: RP_ID,
      origin: ORIGIN,
      requireUserVerification: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.credentialId).equals(authenticator.credentialId)).toBe(true);
    expect(Buffer.from(result.publicKey).equals(authenticator.coseKey)).toBe(true);
    expect(result.signCount).toBe(0);
    expect(result.aaguid).toBe(
      authenticator.aaguid
        .toString('hex')
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
    );
    expect(result.transports).toEqual(['usb', 'nfc']);

    await storeCredential(t, user.userId, result);
    const stored = await loadCredential(t, result.credentialId);
    expect(stored.publicKey.equals(authenticator.coseKey)).toBe(true);
    expect(stored.signCount).toBe(0);
    expect(stored.transports).toEqual(['usb', 'nfc']);
    expect(stored.aaguid).toBe(result.aaguid);
  });

  it('accepts packed self-attestation and rejects a packed statement with x5c', () => {
    const challenge = randomBytes(32);
    const authenticator = new SoftwareAuthenticator();

    const selfAttested = verifyRegistration({
      response: authenticator.register(challenge, { attestationFormat: 'packed' }),
      expectedChallenge: challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    expect(selfAttested.ok).toBe(true);

    const chained = verifyRegistration({
      response: authenticator.register(challenge, { attestationFormat: 'packed', withX5c: true }),
      expectedChallenge: challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    expect(chained).toEqual({ ok: false, reason: 'attestation_x5c_unsupported' });
  });

  it('rejects a packed attestation whose signature does not verify', () => {
    const challenge = randomBytes(32);
    const authenticator = new SoftwareAuthenticator();
    const result = verifyRegistration({
      response: authenticator.register(challenge, {
        attestationFormat: 'packed',
        tamperAttestationSignature: true,
      }),
      expectedChallenge: challenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: false, reason: 'attestation_signature_invalid' });
  });

  it('rejects every failed mandatory check', () => {
    const challenge = randomBytes(32);
    const authenticator = new SoftwareAuthenticator();
    const base = { expectedChallenge: challenge, rpId: RP_ID, origin: ORIGIN } as const;

    // clientData.type
    expect(
      verifyRegistration({ ...base, response: authenticator.register(challenge, { type: 'webauthn.get' }) }),
    ).toEqual({ ok: false, reason: 'client_data_type_mismatch' });

    // challenge
    expect(
      verifyRegistration({ ...base, response: authenticator.register(randomBytes(32)) }),
    ).toEqual({ ok: false, reason: 'challenge_mismatch' });

    // origin
    expect(
      verifyRegistration({
        ...base,
        response: authenticator.register(challenge, { origin: 'https://evil.test' }),
      }),
    ).toEqual({ ok: false, reason: 'origin_mismatch' });

    // rpIdHash
    expect(
      verifyRegistration({ ...base, response: authenticator.register(challenge, { rpId: 'evil.test' }) }),
    ).toEqual({ ok: false, reason: 'rp_id_hash_mismatch' });

    // User Present
    expect(
      verifyRegistration({
        ...base,
        response: authenticator.register(challenge, { flags: FLAG_UV | FLAG_AT }),
      }),
    ).toEqual({ ok: false, reason: 'user_not_present' });

    // User Verified, when the caller demands it
    expect(
      verifyRegistration({
        ...base,
        requireUserVerification: true,
        response: authenticator.register(challenge, { flags: FLAG_UP | FLAG_AT }),
      }),
    ).toEqual({ ok: false, reason: 'user_not_verified' });
    // …and the same ceremony passes when it does not.
    expect(
      verifyRegistration({
        ...base,
        response: authenticator.register(challenge, { flags: FLAG_UP | FLAG_AT }),
      }).ok,
    ).toBe(true);

    // rawId must be the attested credential id
    expect(
      verifyRegistration({
        ...base,
        response: authenticator.register(challenge, { rawIdOverride: randomBytes(32) }),
      }),
    ).toEqual({ ok: false, reason: 'credential_id_mismatch' });

    // attested credential data must be present at all
    expect(
      verifyRegistration({ ...base, response: authenticator.register(challenge, { flags: FLAG_UP | FLAG_UV }) }),
    ).toEqual({ ok: false, reason: 'attested_credential_missing' });

    // garbage in place of the attestation object
    const garbled = authenticator.register(challenge);
    expect(
      verifyRegistration({
        ...base,
        response: { ...garbled, response: { ...garbled.response, attestationObject: b64u(randomBytes(24)) } },
      }).ok,
    ).toBe(false);
  });
});

describe('webauthn — assertion', () => {
  it('verifies a real assertion against the stored public key and advances sign_count', async () => {
    const user = await seedUser(t);
    const authenticator = new SoftwareAuthenticator();
    const registrationChallenge = randomBytes(32);
    const registered = verifyRegistration({
      response: authenticator.register(registrationChallenge),
      expectedChallenge: registrationChallenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    await storeCredential(t, user.userId, registered);

    const stored = await loadCredential(t, registered.credentialId);
    const loginChallenge = randomBytes(32);
    const assertion = verifyAuthentication({
      response: authenticator.assert(loginChallenge, { signCount: 7 }),
      expectedChallenge: loginChallenge,
      rpId: RP_ID,
      origin: ORIGIN,
      publicKey: stored.publicKey,
      storedSignCount: stored.signCount,
      requireUserVerification: true,
    });

    expect(assertion).toEqual({ ok: true, newSignCount: 7 });
    if (!assertion.ok) return;
    await t.client.query(
      `UPDATE user_credentials SET sign_count = $1, last_used_at = now() WHERE credential_pk = $2`,
      [assertion.newSignCount, stored.credentialPk],
    );
    expect((await loadCredential(t, registered.credentialId)).signCount).toBe(7);
  });

  it('rejects a sign_count that did not advance (SEC-02 cloned authenticator)', async () => {
    const user = await seedUser(t);
    const authenticator = new SoftwareAuthenticator();
    const regChallenge = randomBytes(32);
    const registered = verifyRegistration({
      response: authenticator.register(regChallenge),
      expectedChallenge: regChallenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    if (!registered.ok) throw new Error('registration failed');
    const credentialPk = await storeCredential(t, user.userId, registered);
    await t.client.query(`UPDATE user_credentials SET sign_count = 42 WHERE credential_pk = $1`, [
      credentialPk,
    ]);
    const stored = await loadCredential(t, registered.credentialId);
    expect(stored.signCount).toBe(42);

    // The clone replays a lower counter…
    const lowChallenge = randomBytes(32);
    expect(
      verifyAuthentication({
        response: authenticator.assert(lowChallenge, { signCount: 41 }),
        expectedChallenge: lowChallenge,
        rpId: RP_ID,
        origin: ORIGIN,
        publicKey: stored.publicKey,
        storedSignCount: stored.signCount,
      }),
    ).toEqual({ ok: false, reason: 'sign_count_rollback' });

    // …and an equal one is a replay just the same.
    const eqChallenge = randomBytes(32);
    expect(
      verifyAuthentication({
        response: authenticator.assert(eqChallenge, { signCount: 42 }),
        expectedChallenge: eqChallenge,
        rpId: RP_ID,
        origin: ORIGIN,
        publicKey: stored.publicKey,
        storedSignCount: stored.signCount,
      }),
    ).toEqual({ ok: false, reason: 'sign_count_rollback' });

    // The stored counter is untouched by the rejected attempts.
    expect((await loadCredential(t, registered.credentialId)).signCount).toBe(42);

    // One more than stored is accepted — the rejection is the rollback, not the assertion.
    const okChallenge = randomBytes(32);
    expect(
      verifyAuthentication({
        response: authenticator.assert(okChallenge, { signCount: 43 }),
        expectedChallenge: okChallenge,
        rpId: RP_ID,
        origin: ORIGIN,
        publicKey: stored.publicKey,
        storedSignCount: stored.signCount,
      }),
    ).toEqual({ ok: true, newSignCount: 43 });
  });

  it('accepts a counter-less authenticator that reports zero on both sides', () => {
    const authenticator = new SoftwareAuthenticator();
    const regChallenge = randomBytes(32);
    const registered = verifyRegistration({
      response: authenticator.register(regChallenge),
      expectedChallenge: regChallenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    if (!registered.ok) throw new Error('registration failed');

    const challenge = randomBytes(32);
    expect(
      verifyAuthentication({
        response: authenticator.assert(challenge, { signCount: 0 }),
        expectedChallenge: challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        publicKey: registered.publicKey,
        storedSignCount: 0,
      }),
    ).toEqual({ ok: true, newSignCount: 0 });
  });

  it('rejects every failed mandatory check', () => {
    const authenticator = new SoftwareAuthenticator();
    const regChallenge = randomBytes(32);
    const registered = verifyRegistration({
      response: authenticator.register(regChallenge),
      expectedChallenge: regChallenge,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    if (!registered.ok) throw new Error('registration failed');
    const challenge = randomBytes(32);
    const base = {
      expectedChallenge: challenge,
      rpId: RP_ID,
      origin: ORIGIN,
      publicKey: registered.publicKey,
      storedSignCount: 1,
    } as const;

    expect(
      verifyAuthentication({ ...base, response: authenticator.assert(challenge, { type: 'webauthn.create', signCount: 2 }) }),
    ).toEqual({ ok: false, reason: 'client_data_type_mismatch' });

    expect(
      verifyAuthentication({ ...base, response: authenticator.assert(randomBytes(32), { signCount: 2 }) }),
    ).toEqual({ ok: false, reason: 'challenge_mismatch' });

    expect(
      verifyAuthentication({
        ...base,
        response: authenticator.assert(challenge, { origin: 'https://evil.test', signCount: 2 }),
      }),
    ).toEqual({ ok: false, reason: 'origin_mismatch' });

    expect(
      verifyAuthentication({
        ...base,
        response: authenticator.assert(challenge, { rpId: 'evil.test', signCount: 2 }),
      }),
    ).toEqual({ ok: false, reason: 'rp_id_hash_mismatch' });

    expect(
      verifyAuthentication({ ...base, response: authenticator.assert(challenge, { flags: FLAG_UV, signCount: 2 }) }),
    ).toEqual({ ok: false, reason: 'user_not_present' });

    expect(
      verifyAuthentication({
        ...base,
        requireUserVerification: true,
        response: authenticator.assert(challenge, { flags: FLAG_UP, signCount: 2 }),
      }),
    ).toEqual({ ok: false, reason: 'user_not_verified' });

    expect(
      verifyAuthentication({
        ...base,
        response: authenticator.assert(challenge, { tamperSignature: true, signCount: 2 }),
      }),
    ).toEqual({ ok: false, reason: 'signature_invalid' });

    // A signature made by a different authenticator over the same ceremony.
    const impostor = new SoftwareAuthenticator();
    const forged = impostor.assert(challenge, { signCount: 2 });
    expect(verifyAuthentication({ ...base, response: forged })).toEqual({
      ok: false,
      reason: 'signature_invalid',
    });
  });
});

describe('webauthn — RS256', () => {
  it('registers and asserts an RS256 credential end to end through the database', async () => {
    const user = await seedUser(t);
    const authenticator = new SoftwareAuthenticator(COSE_RS256);
    const regChallenge = randomBytes(32);
    const registered = verifyRegistration({
      response: authenticator.register(regChallenge, { attestationFormat: 'packed' }),
      expectedChallenge: regChallenge,
      rpId: RP_ID,
      origin: ORIGIN,
      requireUserVerification: true,
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    await storeCredential(t, user.userId, registered);

    const stored = await loadCredential(t, registered.credentialId);
    const challenge = randomBytes(32);
    expect(
      verifyAuthentication({
        response: authenticator.assert(challenge, { signCount: 3 }),
        expectedChallenge: challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        publicKey: stored.publicKey,
        storedSignCount: stored.signCount,
      }),
    ).toEqual({ ok: true, newSignCount: 3 });

    expect(
      verifyAuthentication({
        response: authenticator.assert(challenge, { tamperSignature: true, signCount: 3 }),
        expectedChallenge: challenge,
        rpId: RP_ID,
        origin: ORIGIN,
        publicKey: stored.publicKey,
        storedSignCount: stored.signCount,
      }),
    ).toEqual({ ok: false, reason: 'signature_invalid' });
  });
});

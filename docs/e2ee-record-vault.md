# End-to-end encryption for personal health records

## Current state

Accounts already support emailed magic links and passkeys. The web app is a PWA,
the `/api/v1` API backs the app and clients, and the CLI and MCP packages can read
the signed-in user's imported records. There is no desktop app in this repository.

The records path is **not end-to-end encrypted** today:

- `health_records.resource` stores provider FHIR resources as `jsonb`.
- `health_files.data` stores downloaded PDFs, images and other attachments as
  readable bytes.
- The current import path uploads files to the server, which classifies and stores
  them. Record, file and export routes return PHI; API keys and the MCP server can
  therefore read it.
- Provider access and refresh tokens use a separate in-memory unlock design.
  That protects the stored token blobs while locked, but says nothing about the
  records in the two tables above.

The same server-access issue applies to clinic-side charts: scheduling, refills,
lab release, summaries, care plans and call workflows read and write clinical data
on the backend. Encrypting those fields so only a patient can decrypt them would
also prevent those existing workflows from operating as written.

## Feasibility and scope

E2EE is feasible for the **personal record vault** if a trusted client does the
provider connection, record fetch, encryption, decryption, search and export. The
server can then store and return opaque ciphertext without seeing medical content.
This is an architecture change, not a database-encryption toggle.

The current file-upload path cannot provide that guarantee because the server
receives and processes plaintext files. The older SMART/FHIR importer also cannot:
when enabled, it exchanges authorization codes and tokens, fetches plaintext FHIR
responses and processes attachments. The API currently returns 410 for new provider
connections. To make file import E2EE, encrypt in the browser before upload. To make
a provider connection E2EE, token exchange and sync must run in a user-controlled
client such as the desktop app or CLI. PWA-only provider sync is also dependent on
each provider's OAuth and browser CORS support. Providers that require a confidential
server credential or prevent client-side API access cannot be advertised as E2EE
sources until a safe client flow exists for them.

This design applies first to records a user imports into their personal vault. It
does not claim E2EE for practice charts or server-run clinical operations.

## Proposed protocol

1. A client generates a random 256-bit vault key. Account login remains separate;
   a magic link or passkey authenticates the account but never unlocks this key.
2. The client wraps the vault key locally with a passphrase-derived key. The server
   stores only the versioned wrapped-key envelope. A recovery secret must be offered
   at setup because losing every unlock secret means permanent data loss.
3. Each record and attachment is encrypted on-device with AES-GCM and a fresh
   random nonce. The authenticated data binds the ciphertext to the account,
   object ID and format version. Display metadata such as names, dates, categories,
   provider names and FHIR identifiers stays inside the ciphertext.
4. The API enforces account ownership and stores opaque object IDs plus ciphertext.
   It does not search, index, summarize, export, or transform the encrypted contents.
5. The PWA, CLI and desktop client share a versioned crypto and envelope library.
   The MCP server does not decrypt in the cloud; an explicitly enabled local MCP
   client may use an already-unlocked local vault, with medical-record tools off by
   default.
6. Sharing requires encrypting a copy or a key envelope for a named recipient.
   Revocation can stop future access but cannot erase plaintext or keys the
   recipient already copied.

The server still learns that an account has vault objects, their opaque IDs, upload
times and ciphertext sizes. A v1 should state that metadata leakage plainly. It
should not claim that the user's device, a compromised app bundle, malware, browser
extensions, or content deliberately sent to an AI/MCP client is protected by E2EE.

## Migration sequence

1. **Freeze the security boundary.** Define the envelope format, KDF parameters,
   recovery and device enrollment behavior, metadata leakage, sharing semantics,
   and the exact records in scope. Keep clinic charts outside the E2EE claim.
2. **Build the shared client crypto and opaque vault API.** Add ownership-checked
   key-envelope and ciphertext-object operations. The server must never accept a
   plaintext fallback on these routes.
3. **Ship one complete client path.** Add local encryption, unlock, decrypt,
   search, export and recovery to the PWA for user-selected local files and FHIR
   bundles. The browser must encrypt before upload; remove plaintext upload as the
   default for vault objects. Keep decrypted keys in memory and clear them on
   lock/sign-out.
4. **Add device clients.** Implement desktop and CLI against the same format,
   store local unlock material with the platform keychain where available, and
   import/export ciphertext without translating it through plaintext server APIs.
5. **Move eligible provider connections local.** Implement OAuth PKCE and FHIR
   sync in the desktop/CLI connector. Add a provider to the E2EE list only after
   confirming its public-client registration, token flow and attachment access.
6. **Add local MCP access deliberately.** Require explicit local configuration and
   a live unlock before an MCP tool can decrypt PHI. Keep server-hosted MCP calls
   limited to opaque vault management.
7. **Offer a user-driven legacy migration.** The old API can deliver a user's
   plaintext records to their unlocked client, which encrypts and uploads them.
   Delete the old rows only after the client confirms counts and hashes. Backups
   containing the old plaintext must expire before claiming those copies are gone.
   Do not silently rewrite or delete medical data.

## Completion criteria

An E2EE claim is accurate only when the server has no path to plaintext during
import, storage, search, export or MCP access; key recovery and device loss behavior
are documented; clients interoperate on the same versioned format; legacy plaintext
is visibly distinguished and migration is user-controlled; and the deployed user
path has been verified from a fresh device. Until then, describe current database
and transport protections precisely, and do not label records E2EE.

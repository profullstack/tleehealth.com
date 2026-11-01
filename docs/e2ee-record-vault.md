# End-to-end encrypted personal record vault

## What is encrypted

The personal vault stores files that a user selects in the PWA or imports with
the CLI. Those clients encrypt each file and the filename, MIME type, category,
size and encrypted index locally before upload. The API stores an opaque key
envelope, ciphertext and the minimum routing data needed to store and return it.
The API has no decrypt, search, preview, export or plaintext import route for
vault objects.

The PWA and CLI share the versioned crypto module exported as
`@profullstack/tleehealth/vault`:

- A random 256-bit data key encrypts files and the index with AES-256-GCM.
- A user passphrase wraps that key with PBKDF2-HMAC-SHA-256 (600,000 iterations)
  and AES-256-GCM. A randomly generated 256-bit recovery key wraps the same key.
- Each object uses a fresh 96-bit nonce. Authenticated data binds it to the
  account, object UUID and format version.
- Account sign-in does not unlock the vault. Passphrase and recovery key are
  entered locally and are not sent to the API. The key is held in process memory
  only while unlocked. On lock or command completion the raw key buffer is
  overwritten and the in-memory key handle is dropped; final cleanup of browser
  cryptographic objects is managed by the runtime.

Setup displays the recovery key once and does not save the key envelope until
the user confirms it was saved. Recovery rotates both the passphrase envelope
and recovery key. Losing both secrets makes the vault permanently unreadable.

The CLI supports `vault status`, `setup`, `recover`, `import`, `list`, `get`,
`delete` and `destroy`. Decrypted files are written with owner-only permissions
and are not overwritten by default. MCP exposes only vault status and opaque
object IDs, byte counts and upload times; it cannot unlock or return filenames,
the encrypted index, or medical contents. This avoids sending vault contents to
an AI tool.

## What remains outside this boundary

- Existing imported records, legacy file uploads, FHIR data, provider sync and
  exports remain server-readable. They are separately labeled in the PWA.
- Clinic charts and server-run clinical workflows remain server-readable.
- The vault currently supports files chosen by the user. Provider OAuth/FHIR
  import does not run inside the vault client.
- There is no desktop application in this repository. The CLI is the current
  native-client path.
- E2EE chat is not provided by this vault.
- Sharing and multi-user key envelopes are not implemented.

Do not migrate or delete legacy records silently. A future migration must let
the user encrypt and verify the count and hashes locally, explain backup
retention, and preserve the legacy copy until the user explicitly confirms.

## Metadata and trust limits

The server can see the account ID, opaque object IDs, object count, ciphertext
sizes, upload times and storage use. The user's device, local malware, browser
extensions, a compromised client bundle, or plaintext deliberately exported or
sent elsewhere are outside this encryption boundary. Because the PWA receives
its code from tleehealth.com, a hostile change to that served code could capture
the passphrase or unlocked data. Use a trusted, updated device and protect the
separate recovery key.

This design protects vault contents from the API and database at rest and during
normal API use. It does not make every health record in the account E2EE, and
the product must keep that distinction visible until the legacy data path is
migrated.

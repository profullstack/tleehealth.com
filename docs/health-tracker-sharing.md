# Sharing health tracker readings

The health tracker (`/health/`) keeps readings encrypted in the browser under
the user's own passphrase. Sharing lets the user hand a copy to someone else,
usually a provider, without making the readings readable by tleehealth.

## How a share works

1. In the unlocked tracker the user chooses **Share readings**. The browser
   makes a random share id and a one-time **share passkey**: 20 Crockford
   base32 characters in four groups (100 bits).
2. The browser builds a snapshot of the readings (kind, value, unit, time,
   note, plus an optional name and message) and encrypts it with a random
   256-bit key under AES-256-GCM. The passkey wraps that key with
   PBKDF2-HMAC-SHA-256 (600,000 iterations), using the same envelope as the
   record vault, bound to the share id.
3. Only the envelope and ciphertext are uploaded (`POST /api/v1/health/shares`).
   The passkey is shown once and is never sent to the server.
4. The user gives the recipient two things, ideally over two channels: the
   link `/share/<id>` and the passkey.
5. The recipient opens the link (no account), enters the passkey, and the
   browser decrypts the readings. They can view them, print them, or download
   a FHIR R4 bundle, a CSV or JSON. A tleehealth user can instead choose
   **Import shared readings** in their own tracker, which re-encrypts the
   readings under their own key.

`tleehealth shared LINK` does the same from a terminal.

## What the server holds

| Stored | Readable by the server |
| --- | --- |
| Share id, owner account, created and expiry times, view count | Yes |
| Key envelope (salt, wrapped key) and ciphertext | No: opaque without the passkey |
| The owner's label ("who it is for"), sealed under the owner's tracker key | No |

A share is a snapshot: later readings are not added to it. It expires after
1, 7, 30 or 90 days (the owner picks), and the owner can revoke it at any time.
Revoking or expiry deletes the ciphertext. An account can hold 25 active shares
of up to 2 MiB each.

## Limits of the protection

- Anyone with the link can download the ciphertext, so the passkey is the
  protection. It is random and 100 bits, which makes guessing infeasible even
  offline; it is not a password the user chooses.
- Anyone holding both the link and the passkey can read that snapshot until it
  expires or is revoked, and can keep a copy. Revoking cannot recall what a
  recipient already downloaded.
- The share page is served by tleehealth, so, as with the tracker itself, a
  hostile change to that served code could capture a passkey when it is typed.
  The page loads no third-party code and sends no referrer.
- The view count says the ciphertext was fetched, not that it was decrypted.

## The provider directory

`/providers` searches every US clinician and healthcare organization that
holds an NPI, by name, specialty, city, state and ZIP. The data is the CMS
NPPES registry (US public domain), the registry NicheDB's health collection
ingests (`nichedb.dev/f/providers`). Searches go to the registry's API because
it answers name and location queries in under a second.

People are listed by city only: a sole practitioner's registered address and
phone are often their home. Organizations show their place of business. The
tracker's share form can search the directory to fill in the private label; the
choice is not sent anywhere.

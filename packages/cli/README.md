# @profullstack/tleehealth

The [tleehealth](https://tleehealth.com) CLI and dashboard TUI.

```sh
npm i -g @profullstack/tleehealth     # or: curl -fsSL https://tleehealth.com/install.sh | sh
tleehealth schedule --date today
tleehealth dashboard                  # Today · Needs · Caseload · Records (alias: tleehealth tui)
```

Your health records uploaded from provider portals:

```sh
tleehealth providers "ucsf"           # search provider names
tleehealth records                    # personal information + counts per category
tleehealth records --category labs    # visits, summaries, notes, labs, imaging, medications, ...
tleehealth export                     # one zip: patient.txt, records.md, labs.csv, files/, raw FHIR
```

Automatic provider connections are paused. Download records from the provider's
portal and import them in the web app under `/portal/records`. Existing imported
records remain available to the CLI.

The separate encrypted personal vault encrypts user-selected files before upload:

```sh
tleehealth vault setup                    # create a passphrase and save the recovery key
tleehealth vault import ./lab-result.pdf  # encryption happens locally
tleehealth vault list                     # unlock and view encrypted-index entries
tleehealth vault get OBJECT_ID --out ./lab-result.pdf
```

The passphrase is prompted without echo and is never saved by the CLI. The random
recovery key is shown once; losing both it and the passphrase makes the vault
unreadable. Existing imported records and clinic charts remain server-readable.
See `docs/e2ee-record-vault.md` in the repository for the exact boundary.

`TLEEHEALTH_API_KEY` and `TLEEHEALTH_URL` override the saved config. Create an API key in the app under Settings, then `tleehealth login th_live_...` or set `TLEEHEALTH_API_KEY`.

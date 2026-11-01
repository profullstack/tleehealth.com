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

`TLEEHEALTH_API_KEY` and `TLEEHEALTH_URL` override the saved config. Create an API key in the app under Settings, then `tleehealth login th_live_...` or set `TLEEHEALTH_API_KEY`.

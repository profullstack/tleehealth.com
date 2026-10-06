# @profullstack/tleehealth

The [tleehealth](https://tleehealth.com) CLI and dashboard TUI.

```sh
npm i -g @profullstack/tleehealth     # or: curl -fsSL https://tleehealth.com/install.sh | sh
tleehealth schedule --date today
tleehealth dashboard                  # Today · Needs · Caseload · Records (alias: tleehealth tui)
```

Your health records from other providers (MyChart and any SMART on FHIR patient portal):

```sh
tleehealth providers "ucsf"           # every Epic/MyChart organization
tleehealth connect "UCSF Health"      # sign in there in your browser; everything is imported
tleehealth records                    # personal information + counts per category
tleehealth records --category labs    # visits, summaries, notes, labs, imaging, medications, ...
tleehealth export                     # one zip: patient.txt, records.md, labs.csv, files/, raw FHIR
```

`TLEEHEALTH_API_KEY` and `TLEEHEALTH_URL` override the saved config. Create an API key in the app under Settings, then `tleehealth login th_live_...` or set `TLEEHEALTH_API_KEY`.

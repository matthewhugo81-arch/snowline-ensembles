# Snowline Ensembles

Live site: https://matthewhugo81-arch.github.io/snowline-ensembles/

This repository is separate from the main Snowline dashboard. GitHub Actions publishes `docs/` to the existing GitHub Pages URL, including generated Met Office indexes. The original Snowline site is untouched.

A buildless dashboard using Snowline's navy and teal design. `npm start` serves a preview on 127.0.0.1:8796; `npm test` verifies chart calculations, binary source decoding, pressure masks, member IDs and run consistency. No synthetic forecasts are shipped to the website.

## Forecast sources

GFS ENS uses Open-Meteo `ncep_gefs_seamless` (31 members), EC ENS uses `ecmwf_ifs025_ensemble` (51), and GEM ENS uses `gem_global_ensemble` (21). These feeds do not identify initialization time in their response; the UI shows retrieval time without guessing a run. Hourly values may be interpolated by the provider. One past day is requested to support preceding-period totals.

MOGREPS-G is taken directly from the [free Met Office AWS dataset](https://registry.opendata.aws/met-office-global-ensemble/). All 18 members of 850 hPa temperature, 500 hPa temperature, total precipitation and snowfall use the same verified initialization, grid point and member IDs. Member 0 is control; perturbed IDs are 1–17 at 00/12Z and 18–34 at 06/18Z. No deterministic temperatures or other models are substituted.

The source reaches +246 hours. Snowline samples temperature every 3 hours and sums native precipitation/snowfall intervals into complete 3-hour periods. Native accumulations are hourly through +132h, then 3-hourly from +135h. They cover the preceding interval, not the whole period since initialization. Six-hour totals sum two complete 3-hour periods. Lead-zero accumulations, missing constituent periods, fill values and below-ground pressure temperatures remain null. The UI disables 1-hour totals when MOGREPS is visible.

Temperatures are converted from Kelvin to Celsius. Precipitation is converted from metres of water to millimetres. Snow water equivalent is converted to centimetres using a fixed 7:1 snow-to-water ratio, matching [Open-Meteo's snowfall convention](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Controllers/VariableHourly.swift). This is a depth equivalent, not a prediction of settling snow. Snow signal is the share of available members with at least 0.1 cm in the selected interval, not calibrated probability.

Native nearest-grid extraction uses 0.1875° latitude × 0.28125° longitude. Temperatures below the surface are masked using the source's pressure flag, including at high terrain. Mean and 10th/90th percentiles include available members, including control. Comparisons align valid times; they do not imply matching initialization times between providers.

## Met Office processing and hosting

`.github/workflows/pages.yml` runs every three hours, on push, and manually. `scripts/index_mogreps.py` finds the newest complete run, validates source metadata, and creates compressed indexes of the required NetCDF/HDF5 byte ranges. It never downloads full model fields. Indexes are cached between builds and distributed with the Pages artifact; weather data is not committed to Git history. A failed update leaves the previous deployment intact. Indexes are retained for 48 hours so open browsers can finish their pinned forecast.

`server/index.ts` is deployed as the isolated `snowline-mogreps` Supabase Edge Function, with JWT verification enabled. It fetches only the source chunks needed for the requested grid point and time, checks file ETags, decodes the original float32 data and pressure flags, and caches each result in `public.snowline_mogreps_cache`. `server/schema.sql` enables RLS and restricts table access to the service role. Existing applications in the hosting project are unchanged. The browser contains only a public anon credential; the service credential is provided through the server environment and is never sent to the browser.

The UI pins one complete run, loads four forecast times concurrently, displays progress and preserves failures as gaps. All 83 times are loaded, supporting the full forecast horizon without further requests. Point results are cached by run/grid/time and expired after 72 hours. A cold location can take around a minute; cached points are faster. Actual run time, grid point and forecast end are visible. The free source is delayed after initialization; runs older than 24 hours are labelled, and runs older than 72 hours are rejected.

For local preview with live MOGREPS, copy the deployed `mogreps/latest.json` into the ignored `docs/mogreps/` folder. Forecast extraction uses the hosted endpoint. To rebuild indexes locally, use Python 3.12 with `scripts/requirements.txt`, then `python scripts/index_mogreps.py`. The `--probe` option indexes +24h and its constituent accumulation files without changing the latest pointer.

## Interface and exports

Automatic axes include member extremes. Manual/fixed scales report clipped values. Zoom and inspection are linked across panels. CSV includes coordinates, source, licence, retrieval time, verified run time where supplied, valid time, interval and actual member IDs; nulls are empty fields. SVG exports include source attribution and run information.

Search uses Open-Meteo/GeoNames. The map uses Leaflet and OpenStreetMap. Favourites, recent places and theme are stored locally. Forecasts are held in browser memory until refresh. Shared URLs contain the selected location and model.

Open-Meteo data is attributed under CC BY 4.0; its free hosted API is rate-limited and intended for noncommercial use. Met Office MOGREPS data and adapted extracts are attributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Snowline's transformations are point extraction, masking, unit conversion and period aggregation. Relevant source documentation: [Met Office external channels](https://www.metoffice.gov.uk/services/data/external-data-channels), [Open-Meteo ensemble API](https://open-meteo.com/en/docs/ensemble-api).

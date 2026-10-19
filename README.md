# Snowline Ensembles

Live site: https://matthewhugo81-arch.github.io/snowline-ensembles/

This is a separate repository and GitHub Pages site from the main Snowline dashboard. GitHub Pages publishes `main` → `/docs`; `.nojekyll` keeps the site buildless. Updates to this repository do not change the original Snowline site.

A buildless ensemble dashboard using Snowline's navy, teal, Manrope and DM Sans design. Open `docs/index.html` through an HTTP server. `npm start` serves a local preview on 127.0.0.1:8796; `npm test` verifies calculations. Deployment assets are in `docs/`.

## Data

All charts use actual Open-Meteo ensemble API responses, never simulated or bundled forecast data. GFS ENS uses `ncep_gefs_seamless` (31 members, up to 16 days in this UI), EC ENS uses `ecmwf_ifs025_ensemble` (51 / 15), GEM ENS uses `gem_global_ensemble` (21 / 16), and MOGREPS-G uses `ukmo_global_ensemble_20km` (18 / 8). Data availability is checked per value. MOGREPS pressure-level ensemble temperatures are not supplied by this feed and remain unavailable.

The API is requested at its default hourly resolution with one past day so complete preceding-hour accumulations can be calculated. Member 0 is the unsuffixed API key. Remaining keys use `_memberNN`. Mean and interpolated 10th/90th percentiles include all available members, including control. MOGREPS member 0 is labelled as such because its role is not verified. Snow signal is the fraction of nonmissing members with snowfall >= 0.1 cm in the selected preceding period. It is uncalibrated member agreement. The operational deterministic GFS forecast in the reference screenshot is not included.

Precipitation/snowfall 3h and 6h values are sums of three or six consecutive preceding hourly values, including the hour ending at the labelled timestamp. Any missing constituent makes the accumulation missing. Temperature values are sampled at those timestamps. All timestamps use UTC Unix seconds. API retrieval time is labelled honestly; the response does not identify initialization time. The service can interpolate and combine its latest model feeds, so this is not an archive of run-pure forecasts. Mean comparison does not claim matching initialization times.

Automatic axes include all members and outliers. Manual/fixed scales report clipped member values. Zoom and inspection are synchronized across panels. CSV includes requested coordinates, provider identifier, retrieval time, valid time, interval, member number and nulls as empty fields. SVG exports include attribution.

Location search uses Open-Meteo geocoding/GeoNames. The map is Leaflet 1.9.4 (SRI-verified CDN assets) with OpenStreetMap tiles. Favourites, recent places and theme are stored locally in the browser. Forecasts are cached only in memory until refresh. URL sharing includes location and selected model.

Open-Meteo free hosted API access is rate-limited and for noncommercial use. A commercial rollout needs the appropriate Open-Meteo licence and a server-side credential strategy. Data attribution is shown in the interface and chart exports (CC BY 4.0). Sources: https://open-meteo.com/en/docs/ensemble-api and https://open-meteo.com/en/pricing.

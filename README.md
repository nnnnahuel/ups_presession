# UPS Session Prep Board

## Playlist rotation

The backend now includes a Spotify playlist rotation agent for Railway.

Required environment variables:

- `DATABASE_URL`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN`
- `LASTFM_API_KEY`
- `SPOTIFY_MAIN_PLAYLIST_ID`
- `SPOTIFY_ARCHIVE_PLAYLIST_ID`
- `PLAYLIST_API_TOKEN`

Optional tuning:

- `PLAYLIST_ROTATION_COUNT` default `5`
- `PLAYLIST_MIN_PLAYLIST_SIZE` default `40`
- `PLAYLIST_COOLDOWN_DAYS` default `45`
- `PLAYLIST_EXPLICIT_PENALTY` default `0.3`
- `PLAYLIST_TRACK_SIMILAR_BONUS` default `1.2`
- `PLAYLIST_LASTFM_SIMILAR_TRACKS_LIMIT` default `15`
- `PLAYLIST_LASTFM_SIMILAR_ARTISTS_LIMIT` default `10`
- `PLAYLIST_SPOTIFY_SEARCH_LIMIT` default `10`

Operational entry points:

- `POST /api/playlist/rotate`
- `GET /api/playlist/logs`
- `npm run playlist:rotate`
- `npm run playlist:token`

For Railway Cron, call `POST /api/playlist/rotate` with `Authorization: Bearer <PLAYLIST_API_TOKEN>`.
For local Spotify OAuth, register `http://127.0.0.1:8888/callback` as the redirect URI.

## Training song requests

The backend exposes internal endpoints for athlete song requests. They are protected
with the same `PLAYLIST_API_TOKEN` bearer token and are intended to be called
server-to-server from `ups_payments`.

Studio account environment variables:

- `SPOTIFY_STUDIO_A_REFRESH_TOKEN` falls back to `SPOTIFY_GYM_REFRESH_TOKEN`
- `SPOTIFY_STUDIO_B_REFRESH_TOKEN`
- `SPOTIFY_STUDIO_A_DEVICE_ID` optional, falls back to `SPOTIFY_GYM_DEVICE_ID`
- `SPOTIFY_STUDIO_B_DEVICE_ID` optional
- `SPOTIFY_STUDIO_A_LABEL` optional, default `Estudio A UP.S`
- `SPOTIFY_STUDIO_B_LABEL` optional, default `Estudio B UP.S`

Playlist guard environment variables:

- `SPOTIFY_GYM_PLAYLIST_ID` optional, falls back to `SPOTIFY_MAIN_PLAYLIST_ID`
- `SPOTIFY_GYM_PLAYLIST_NAME` optional, default `UP.S - SPT`
- `SPOTIFY_PLAYLIST_GUARD_STUDIOS` optional, default `studio-a`
- `SPOTIFY_PLAYLIST_GUARD_ENABLED` optional, set `false` to disable
- `SPOTIFY_PLAYLIST_HANDOFF_DELAY_SECONDS` optional, default `22`
- `SPOTIFY_PLAYLIST_HANDOFF_TIMEOUT_SECONDS` optional, default `900`
- `SPOTIFY_PLAYLIST_HANDOFF_POLL_SECONDS` optional, default `5`

Operational entry points:

- `GET /api/spotify/studios`
- `GET /api/spotify/devices?studio=studio-a`
- `GET /api/spotify/search?studio=studio-a&q=<query>`
- `POST /api/spotify/queue` with body `{ "studio": "studio-a", "uri": "spotify:track:..." }`
- `POST /api/spotify/playlist-guard` to ensure the gym playlist is active and repeating.
  Defaults to immediate mode; pass `mode=soft` for handoff mode.

Search excludes explicit tracks by default unless `include_explicit=true` is sent.
Queueing accepts both explicit and non-explicit tracks.

The server also runs the playlist guard every day at 07:00 and 15:00
`America/Argentina/Buenos_Aires` in soft handoff mode. If the gym playlist is
already active, it does nothing except ensure Spotify repeat mode is `context`.
If nothing is playing, it starts the gym playlist directly. If another context is
playing, it queues one track from the gym playlist, waits for that track to begin,
waits past the crossfade window, then anchors playback back to the gym playlist
from that same track and sets repeat mode to `context`. If the queued track does
not start before the timeout, it does not cut the current music.

## Studio screen worker

The Windows worker that applies system-volume commands connects to
`https://sesiones.up-s.ar` by default. Set `SERVER_URL` only when deliberately
targeting another deployment. The worker also requires `DEVICE_ID`,
`LOCATION_ID`, and the matching `WORKER_TOKEN`.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

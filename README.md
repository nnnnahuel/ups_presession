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

- `PLAYLIST_ROTATION_COUNT` default `10`
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

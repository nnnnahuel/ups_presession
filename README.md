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

## Pantalla del estudio v2 (`/screen/v2`)

Pantalla nueva con cuenta regresiva, voz y lobby de nombres. Vive aparte de
`/screen`, que sigue igual.

### Abrir Chrome en la notebook para que la voz suene sola

Chrome no deja sonar audio hasta que alguien toca la página. Para que la
pantalla hable sin que nadie la toque, abrí Chrome con este acceso directo
(un perfil propio hace que la opción se aplique aunque haya otro Chrome abierto):

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required --user-data-dir="%LOCALAPPDATA%\UPS-Pantalla" "https://sesiones.up-s.ar/screen/v2?studio=A&key=CLAVE_DE_PANTALLA"
```

- `CLAVE_DE_PANTALLA` es el valor de `SCREEN_DISPLAY_KEY` en el servidor. La
  pantalla la guarda en el navegador, así que una recarga sin `key` sigue
  funcionando; `?key=` vacío la borra. Sin clave (o con una incorrecta) la
  pantalla anda por reloj, sin nombres y sin latido.
- `--kiosk` la abre a pantalla completa; para salir, `Alt+F4`.
- Para el Estudio B, usá `studio=B` en la dirección.
- Si igual aparece «Activar sonido», un toque, un clic o cualquier tecla lo
  resuelve. Con el sonido activo queda un parlante chico abajo a la derecha.
- Para ver desde afuera si la pantalla está abierta y con sonido:
  `GET /screen/api/health` → campo `screenDisplays` (`online`, `audioUnlocked`,
  `voiceReady`, `lastCue`, `lastCueAt`). La pantalla avisa cada 30 segundos.

### Modo de prueba

`/screen/v2?demo=1&now=20:57:00&speed=10&mute=1`

- `now=HH:MM:SS` arranca un reloj simulado a esa hora; `speed=N` lo acelera.
- `demo=1` usa 6 atletas falsos (con su número de sesión, una primera sesión y
  un hito) que se van encendiendo; `athletes=N` (de 1 a 8) cambia cuántos son.
  `demo=first` simula la primera clase del bloque (sin clase anterior) y
  `demo=idle`, un día sin clases.
- `mute=1` calla la voz.
- `roster=grid` muestra los nombres en dos filas con letra más grande. Es una
  variante para comparar con la fila de siempre: cuando se elija una, se borra
  la otra. Anda también sin modo de prueba.
- Con `now`, `speed` o `demo` la pantalla nunca toca el volumen ni manda el
  latido. **Sin esos parámetros actúa sobre el estudio de verdad** (baja la
  música por los mismos endpoints que `/screen`).

### Servidor

Variables de entorno:

- `UPS_PORTAL_API_BASE_URL`: dirección del portal (`ups_payments`).
- `STUDIO_SCREEN_API_TOKEN`: token con el que el servidor le pide el lobby al portal.
- `SCREEN_DISPLAY_KEY`: clave de la pantalla. La pantalla la manda en el header
  `X-Screen-Key` al pedir el lobby y en el latido. Sin esta variable, el lobby y
  el latido quedan cerrados.

Endpoints:

- `GET /screen/api/lobby?studio=A|B` (con `X-Screen-Key`) pide al portal
  `${UPS_PORTAL_API_BASE_URL}/api/studio-screen/lobby/?studio=A` con
  `Authorization: Bearer ${STUDIO_SCREEN_API_TOKEN}` y guarda la respuesta
  4 segundos. De cada atleta pasa `id`, `name`, `checked_in_at`,
  `first_session`, `session_number` (entero ≥ 1, si no `null`: la ficha muestra
  solo el nombre) y `milestone`. Sin clave correcta responde `{"ok": false}` sin preguntarle nada
  al portal; sin las variables del portal o si el portal falla, también
  `{"ok": false}`. En esos casos la pantalla sigue por reloj como si hubiera
  clase todas las horas, sin nombres.
- `POST /screen/api/display/heartbeat` (con `X-Screen-Key`) guarda el estado de
  la pantalla; sin clave correcta no guarda nada. `GET /screen/api/health` es
  público y lo muestra en `screenDisplays`.
- `POST /screen/tts` solo acepta las frases fijas: las de
  `public/screen/script.js` y las de `public/screen/v2/voice-lines.js`. Otro
  texto → 400. El audio queda guardado en la tabla `screen_tts_audio`, así que
  cada frase se paga a ElevenLabs una sola vez.
- Las frases de la voz se retocan en `public/screen/v2/voice-lines.js`; los
  textos de pantalla y los tiempos, arriba de `public/screen/v2/app.js`. Los
  cortes de la barra de abajo (4 ejercicios y el extra) son `EXERCISE_CUTS`,
  en minutos de la clase.

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

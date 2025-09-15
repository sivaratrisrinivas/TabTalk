# TabTalk

Clean, lean, two-person video calling in the browser. WebRTC for media, Socket.IO for signaling. One tab starts, the other answers.

## What’s inside
- Client (`app.js`):
  - WebRTC setup with room-based signaling
  - Mute / Video toggle / Share Screen / Restart ICE
  - Basic audio processing (EQ + compressor) with safe bitrate tuning
  - Glare protection and connection status UI
- Server (`server.js`):
  - Socket.IO-only, room-scoped relay
  - Join acknowledgment for reliable tests
- UI (`index.html`): clean Meet-like styling, minimal controls
- Tests:
  - Unit (Jest): signaling relay works
  - E2E (Playwright): two tabs connect, glare path, toggles, ICE restart

## Quick start
1) Install
```
npm i
npx playwright install --with-deps
```

2) Run the app
```
# Terminal 1: signaling only on 3000
node server.js

# Terminal 2: serve static files on 5500
npx http-server -p 5500 .

# In your browser: open two tabs
http://localhost:5500/#room1
```

3) Tests
```
# Unit
npm test

# E2E (uses a separate static port)
STATIC_PORT=5510 npm run test:e2e
```

## Notes
- Port 3000 is signaling only; it does not serve HTML.
- The client always connects to Socket.IO at http://localhost:3000.
- Audio sender bitrate is tuned only when the browser exposes writeable encodings.

## Project structure
```
app.js                 # client logic (WebRTC + UI helpers)
index.html             # UI (Meet-like, minimal)
server.js              # Socket.IO signaling (rooms)
__tests__/             # Jest unit tests
tests-e2e/             # Playwright e2e tests
playwright.config.ts   # Playwright runner config
jest.config.js         # Jest config
```

## Troubleshooting
- “Cannot connect to signaling”: ensure `node server.js` is running and the page is on `#room…`.
- “No remote video”: both tabs must use the same room hash (e.g., `#room1`).
- “Jest did not exit”: harmless open handle warning; CI can use `jest --runInBand --forceExit`.

## License
MIT

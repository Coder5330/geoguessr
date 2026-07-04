# GuessWhere multiplayer server

## Deploy to Railway

1. Create a new Railway project, choose "Deploy from local files" or push this folder to a new GitHub repo and deploy from there.
2. In Railway's project settings, add an environment variable:
   - `MAPILLARY_TOKEN` = your Mapillary client token (the same MLY|... one used in the client)
3. Railway auto-detects Node and runs `npm start`.
4. Once deployed, Railway gives you a domain like `xxxx-production.up.railway.app`.
5. In `geoguesser.html`, set:
   ```js
   const WS_URL = "wss://xxxx-production.up.railway.app";
   ```
   Note: `wss://` not `https://` — same domain, different protocol prefix for WebSockets.

## Local testing

```
npm install
MAPILLARY_TOKEN=your_token_here npm start
```

Then in the client, temporarily set `WS_URL = "ws://localhost:8080"` to test locally before deploying.
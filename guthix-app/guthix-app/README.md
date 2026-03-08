# GUTHIX App — Deploy to Railway

## Local dev
```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy to Railway (one-time setup)

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Select the repo — Railway auto-detects Node and deploys
4. Your app is live at `https://your-app.up.railway.app`

## File structure
```
public/
  index.html   ← landing page
  swap.html    ← swap UI  (at /swap.html)
server.js      ← Express static server
package.json
```

## URLs
- Landing: `https://your-app.up.railway.app/`
- Swap:    `https://your-app.up.railway.app/swap.html`
